// src/content/gemini.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import {
  BookOutlineDto,
  ChapterOutline,
} from './dto/generate-travel-guide.dto';

interface APIProvider {
  type: 'gemini' | 'openai';
  client: GoogleGenerativeAI | OpenAI;
  model: string;

  lastUsedAt: number; // timestamp of last API call
  rateLimitedUntil: number; // when rate limit expires (0 = not limited)

  // ── NEW: Track consecutive errors per provider ──
  consecutiveErrors: number;
  lastErrorAt: number;
  lastErrorType: string | null;
}

type ContentType = 'travel' | 'farming';

type ChapterFormat =
  | 'SCENE_NARRATIVE'
  | 'DIRECT_INSTRUCTION'
  | 'PROBLEM_SOLUTION'
  | 'COMPARE_CONTRAST';

const CHAPTER_FORMATS: ChapterFormat[] = [
  'SCENE_NARRATIVE',
  'DIRECT_INSTRUCTION',
  'PROBLEM_SOLUTION',
  'COMPARE_CONTRAST',
];

// ═══════════════════════════════════════════════════════════════
// DUAL SYSTEM PROMPTS — Travel vs Farming
// ═══════════════════════════════════════════════════════════════

const TRAVEL_SYSTEM_PROMPT = `You are Marcus Chen, a seasoned travel writer with 18 years of on-the-ground experience across 60+ countries. You write with the informal authority of someone who has actually been there — you know which alley has the best dumplings, which "must-see" attractions are overrated, and which hidden spots locals guard jealously.

Your writing voice:
- Confident but never preachy
- Wry humor, occasional self-deprecation
- You admit when something disappointed you
- Short punchy sentences mixed with longer flowing ones
- You reference real sensory memories: the smell of rain on laterite soil, the clatter of a tuk-tuk engine, the sting of fish sauce on a paper cut

ABSOLUTELY NEVER use these words/phrases — they are dead giveaways of AI writing:
"delve", "tapestry", "vibrant", "nestled", "bustling", "hidden gem", "rich tapestry",
"myriad", "plethora", "embark on a journey", "a testament to", "it's worth noting",
"in terms of", "when it comes to", "at the end of the day", "offers something for everyone",
"whether you're a ... or a ...", "from ... to ..., there's something for everyone",
"seamlessly", "effortlessly", "game-changer", "elevate your experience",
"unforgettable", "breathtaking", "stunning", "picturesque", "charming",
"quaint", "idyllic", "azure", "lush", "verdant", "sun-drenched",
"a feast for the senses", "leave you wanting more", "beckons",
"venture", "uncover", "immerse yourself", "soak in", "indulge in",
"boasts", "world-class", "unparalleled", "second to none",
"comprehensive guide", "everything you need to know", "ultimate guide"

Instead use plain, specific language. Say "good" not "exquisite". Say "cheap" not "budget-friendly". Say "old" not "historic" (unless it actually matters). Be direct.`;

const FARMING_SYSTEM_PROMPT = `You are Dale Hutchins, a practical farming writer with 22 years of hands-on experience — you've raised livestock, managed crop rotations, lost harvests to bad weather, and rebuilt. You write for people who actually get dirt under their nails. Your advice comes from doing, not from textbooks.

Your writing voice:
- Practical and no-nonsense — every sentence should be useful
- Honest about failures: you've lost chickens to predators, had crops fail, made expensive mistakes
- Folksy without being corny — you respect your readers' intelligence
- Short punchy sentences mixed with longer explanations when the detail matters
- You reference real farm sensory details: the smell of fresh-turned soil, the sound of rain on a metal barn roof, the weight of a full feed bucket at 5 AM

ABSOLUTELY NEVER use these words/phrases — they are dead giveaways of AI writing:
"delve", "tapestry", "vibrant", "nestled", "bustling", "hidden gem",
"myriad", "plethora", "embark on a journey", "a testament to", "it's worth noting",
"in terms of", "when it comes to", "at the end of the day",
"seamlessly", "effortlessly", "game-changer", "elevate",
"sustainable practices" (say "what actually lasts"), "holistic approach" (say "the whole picture"),
"synergy", "optimize", "leverage", "utilize" (say "use"),
"implement" (say "do" or "try"), "facilitate", "endeavor",
"comprehensive", "robust", "innovative", "cutting-edge",
"revolutionize", "transform your farm", "unlock the potential",
"best practices" (say "what works"), "paradigm", "ecosystem" (unless literally about ecology),
"journey" (say "process" or "work"), "passion" (show it, don't say it),
"empower", "thrive", "flourish"

Instead use plain, direct language. Say "works well" not "proves highly effective". Say "costs less" not "economically viable". Say "tough" not "resilient". Be direct and specific — give numbers, timelines, and amounts.`;

// ═══════════════════════════════════════════════════════════════
// Post-processing patterns — shared + domain-specific
// ═══════════════════════════════════════════════════════════════

const SHARED_AI_TELL_PATTERNS: Array<{ pattern: RegExp; replacement: string }> =
  [
    { pattern: /\bdelve(?:s|d)?\b/gi, replacement: 'dig' },
    { pattern: /\btapestry\b/gi, replacement: 'mix' },
    { pattern: /\bmyriad\b/gi, replacement: 'many' },
    { pattern: /\bplethora\b/gi, replacement: 'plenty' },
    { pattern: /\bseamlessly\b/gi, replacement: 'smoothly' },
    { pattern: /\beffortlessly\b/gi, replacement: 'easily' },
    { pattern: /\bembark on a journey\b/gi, replacement: 'get started' },
    { pattern: /\ba testament to\b/gi, replacement: 'proof of' },
    { pattern: /\bit's worth noting\b/gi, replacement: '' },
    { pattern: /\baforementioned\b/gi, replacement: 'that' },
    { pattern: /\bfurthermore\b/gi, replacement: 'also' },
    { pattern: /\bmoreover\b/gi, replacement: 'and' },
    { pattern: /\bin conclusion\b/gi, replacement: '' },
    { pattern: /\bIn summary\b/gi, replacement: '' },
    { pattern: /\bgame-changer\b/gi, replacement: 'big deal' },
    { pattern: /\butilize\b/gi, replacement: 'use' },
    { pattern: /\bleverage\b/gi, replacement: 'use' },
    { pattern: /\bfacilitate\b/gi, replacement: 'help' },
  ];

const TRAVEL_AI_TELL_PATTERNS: Array<{ pattern: RegExp; replacement: string }> =
  [
    { pattern: /\bvibrant\b/gi, replacement: 'lively' },
    { pattern: /\bnestled\b/gi, replacement: 'tucked' },
    { pattern: /\bbustling\b/gi, replacement: 'busy' },
    { pattern: /\bhidden gem(s)?\b/gi, replacement: 'good find$1' },
    { pattern: /\bunforgettable\b/gi, replacement: 'memorable' },
    { pattern: /\bbreathtak(?:ing|ingly)\b/gi, replacement: 'striking' },
    { pattern: /\bpicturesque\b/gi, replacement: 'pretty' },
    { pattern: /\bworld-class\b/gi, replacement: 'top-tier' },
    { pattern: /\bunparalleled\b/gi, replacement: 'rare' },
    { pattern: /\bimmerse yourself\b/gi, replacement: 'get into' },
    { pattern: /\bboasts\b/gi, replacement: 'has' },
    { pattern: /\bsun-drenched\b/gi, replacement: 'sunny' },
    { pattern: /\bazure\b/gi, replacement: 'blue' },
    { pattern: /\bverdant\b/gi, replacement: 'green' },
    { pattern: /\blush\b/gi, replacement: 'thick' },
    { pattern: /\bculinary\b/gi, replacement: 'food' },
    { pattern: /\bgastronomic\b/gi, replacement: 'food' },
    { pattern: /\bquaint\b/gi, replacement: 'small' },
    { pattern: /\bidyllic\b/gi, replacement: 'peaceful' },
    { pattern: /\bbeckons\b/gi, replacement: 'calls' },
  ];

const FARMING_AI_TELL_PATTERNS: Array<{
  pattern: RegExp;
  replacement: string;
}> = [
  {
    pattern: /\bsustainable practices\b/gi,
    replacement: 'what actually lasts',
  },
  { pattern: /\bholistic approach\b/gi, replacement: 'the whole picture' },
  { pattern: /\bbest practices\b/gi, replacement: 'what works' },
  { pattern: /\binnovative\b/gi, replacement: 'newer' },
  { pattern: /\bcutting-edge\b/gi, replacement: 'modern' },
  { pattern: /\brobust\b/gi, replacement: 'strong' },
  { pattern: /\boptimize\b/gi, replacement: 'improve' },
  { pattern: /\bimplement\b/gi, replacement: 'try' },
  { pattern: /\bflourish\b/gi, replacement: 'do well' },
  { pattern: /\bthrive\b/gi, replacement: 'do well' },
  { pattern: /\bempower\b/gi, replacement: 'help' },
  { pattern: /\brevolutionize\b/gi, replacement: 'change' },
  {
    pattern: /\btransform your farm\b/gi,
    replacement: 'improve your operation',
  },
  { pattern: /\bunlock the potential\b/gi, replacement: 'get more out of' },
  { pattern: /\bparadigm\b/gi, replacement: 'approach' },
  { pattern: /\bsynergy\b/gi, replacement: 'working together' },
  { pattern: /\bendeavor\b/gi, replacement: 'effort' },
  { pattern: /\bcomprehensive\b/gi, replacement: 'thorough' },
];

const SENTENCE_UNIFORMITY_PATTERNS = [
  /(?:^|\. )The (?:\w+ ){2,}/g,
  /(?:^|\. )You (?:can|will|should|might) /g,
];

@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  private apiProviders: APIProvider[] = [];
  private currentProviderIndex: number = 0;
  private readonly MAX_RETRIES = 5;
  private readonly INITIAL_RETRY_DELAY = 6000;

  // ── Per-provider cooldown settings ──────────────────────────
  private readonly PROVIDER_COOLDOWN_MS = 5000; // Min 5s between calls to same key
  private readonly RATE_LIMIT_LOCKOUT_MS = 60000; // Lock out for 60s after 429

  private readonly REQUEST_TIMEOUT_MS = 45000; // 45s timeout per request
  private readonly PROVIDER_SWITCH_DELAY_MS = 4000; // 4s delay when switching after failure
  private readonly MAX_CONSECUTIVE_ERRORS = 5; // Max errors before extended lockout
  private readonly EXTENDED_LOCKOUT_MS = 300000; // 5 min lockout after too many errors

  constructor(private configService: ConfigService) {
    this.initializeProviders();

    if (this.apiProviders.length === 0) {
      throw new Error(
        'At least one API key (GEMINI or OPENAI) must be configured',
      );
    }

    this.logger.log(
      `Service initialized with ${this.apiProviders.length} API provider(s)`,
    );
    this.apiProviders.forEach((provider, idx) => {
      this.logger.log(
        `Provider ${idx + 1}: ${provider.type} (${provider.model})`,
      );
    });
  }

  private initializeProviders(): void {
    const geminiPrimary = this.configService.get<string>('GEMINI_API_KEY');
    const geminiSecondary = this.configService.get<string>('GEMINI_API_KEYS');

    const geminiKeys: string[] = [];
    if (geminiPrimary) geminiKeys.push(geminiPrimary);
    if (geminiSecondary) {
      const keys = geminiSecondary
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k);
      geminiKeys.push(...keys);
    }

    const uniqueGeminiKeys = [...new Set(geminiKeys)];
    uniqueGeminiKeys.forEach((key) => {
      this.apiProviders.push({
        type: 'gemini',
        client: new GoogleGenerativeAI(key),
        model: 'gemini-2.5-flash-lite',
        lastUsedAt: 0,
        rateLimitedUntil: 0,
        consecutiveErrors: 0,
        lastErrorAt: 0,
        lastErrorType: null,
      });
    });

    const openaiKey = this.configService.get<string>('OPENAI_API_KEY');

    if (openaiKey) {
      this.apiProviders.push({
        type: 'openai',
        client: new OpenAI({ apiKey: openaiKey }),
        model: 'gpt-4.1-nano',
        lastUsedAt: 0,
        rateLimitedUntil: 0,
        consecutiveErrors: 0,
        lastErrorAt: 0,
        lastErrorType: null,
      });
    }
  }

  // ══════════════════════════════════════════════════════════════
  // FIXED: Improved provider selection with error tracking
  // ══════════════════════════════════════════════════════════════
  private getNextProvider(): APIProvider | null {
    const now = Date.now();

    // Filter out rate-limited and error-locked providers
    const available = this.apiProviders.filter((p) => {
      if (now < p.rateLimitedUntil) return false;
      // Skip providers with too many consecutive errors (extended lockout)
      if (p.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
        const timeSinceError = now - p.lastErrorAt;
        if (timeSinceError < this.EXTENDED_LOCKOUT_MS) {
          return false;
        }
        // Reset if lockout period passed
        p.consecutiveErrors = 0;
      }
      return true;
    });
    if (available.length === 0) return null;
    // Prefer providers with fewer errors, then pick the one idle longest
    available.sort((a, b) => {
      if (a.consecutiveErrors !== b.consecutiveErrors) {
        return a.consecutiveErrors - b.consecutiveErrors;
      }
      return a.lastUsedAt - b.lastUsedAt;
    });
    return available[0];
  }
  private async waitForProviderCooldown(provider: APIProvider): Promise<void> {
    const now = Date.now();
    const timeSinceLastUse = now - provider.lastUsedAt;
    if (
      timeSinceLastUse < this.PROVIDER_COOLDOWN_MS &&
      provider.lastUsedAt > 0
    ) {
      const waitTime = this.PROVIDER_COOLDOWN_MS - timeSinceLastUse;
      this.logger.debug(
        `Provider ${provider.type} cooling down ${waitTime}ms...`,
      );
      await this.sleep(waitTime);
    }
  }
  // ══════════════════════════════════════════════════════════════
  // NEW: Network error detection
  // ══════════════════════════════════════════════════════════════
  private isNetworkError(error: any): boolean {
    const message = error?.message?.toLowerCase() || '';
    const code = error?.code?.toLowerCase() || '';

    return (
      message.includes('fetch failed') ||
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('econnrefused') ||
      message.includes('socket hang up') ||
      message.includes('network') ||
      message.includes('dns') ||
      message.includes('getaddrinfo') ||
      message.includes('enotfound') ||
      message.includes('enetunreach') ||
      message.includes('ehostunreach') ||
      code === 'econnreset' ||
      code === 'etimedout' ||
      code === 'econnrefused' ||
      code === 'enotfound' ||
      error?.name === 'AbortError' ||
      error?.name === 'TimeoutError'
    );
  }
  private isRateLimitError(error: any): boolean {
    return (
      error?.status === 429 ||
      error?.message?.includes('rate limit') ||
      error?.message?.includes('quota') ||
      error?.message?.includes('too many requests') ||
      error?.message?.includes('Resource has been exhausted')
    );
  }
  private isOverloadError(error: any): boolean {
    return (
      error?.status === 503 ||
      error?.status === 502 ||
      error?.status === 500 ||
      error?.message?.includes('overloaded') ||
      error?.message?.includes('unavailable') ||
      error?.message?.includes('capacity')
    );
  }
  private isRetryableError(error: any): boolean {
    return (
      this.isNetworkError(error) ||
      this.isRateLimitError(error) ||
      this.isOverloadError(error)
    );
  }
  // ══════════════════════════════════════════════════════════════
  // NEW: Add jitter to prevent thundering herd
  // ══════════════════════════════════════════════════════════════
  private addJitter(baseMs: number, jitterPercent: number = 0.3): number {
    const jitter = baseMs * jitterPercent * (Math.random() - 0.5) * 2;
    return Math.max(100, Math.floor(baseMs + jitter));
  }

  // ═══════════════════════════════════════════════════════════════
  // CONTENT TYPE DETECTION — Travel vs Farming
  // ═══════════════════════════════════════════════════════════════
  private detectContentType(title: string): ContentType {
    const farmingKeywords = [
      'farm',
      'farming',
      'agriculture',
      'agricultural',
      'crop',
      'crops',
      'harvest',
      'livestock',
      'poultry',
      'raising',
      'breeding',
      'husbandry',
      'chicken',
      'cattle',
      'pig',
      'sheep',
      'goat',
      'bee',
      'aquaculture',
      'garden',
      'gardening',
      'homestead',
      'permaculture',
      'organic farm',
      'dairy',
      'horticulture',
      'irrigation',
      'plantation',
      'ranch',
      'veterinary',
      'soil',
      'compost',
      'fertilizer',
      'tractor',
    ];
    const lowerTitle = title.toLowerCase();
    const isFarming = farmingKeywords.some((keyword) =>
      lowerTitle.includes(keyword),
    );

    this.logger.log(
      `Content type detected for "${title}": ${isFarming ? 'FARMING' : 'TRAVEL'}`,
    );

    return isFarming ? 'farming' : 'travel';
  }

  private getSystemPrompt(contentType: ContentType): string {
    return contentType === 'farming'
      ? FARMING_SYSTEM_PROMPT
      : TRAVEL_SYSTEM_PROMPT;
  }

  private getAITellPatterns(
    contentType: ContentType,
  ): Array<{ pattern: RegExp; replacement: string }> {
    const domainPatterns =
      contentType === 'farming'
        ? FARMING_AI_TELL_PATTERNS
        : TRAVEL_AI_TELL_PATTERNS;

    return [...SHARED_AI_TELL_PATTERNS, ...domainPatterns];
  }

  // ══════════════════════════════════════════════════════════════
  // FIXED: Provider calls with timeout using AbortController
  // ══════════════════════════════════════════════════════════════
  private async generateWithProvider(
    provider: APIProvider,
    prompt: string,
    systemPrompt: string = TRAVEL_SYSTEM_PROMPT,
  ): Promise<string> {
    await this.waitForProviderCooldown(provider);
    provider.lastUsedAt = Date.now();
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.REQUEST_TIMEOUT_MS);
    try {
      if (provider.type === 'gemini') {
        const model = (
          provider.client as GoogleGenerativeAI
        ).getGenerativeModel({
          model: provider.model,
          generationConfig: {
            temperature: 1.0,
            topP: 0.92,
            topK: 50,
            maxOutputTokens: 8192,
          },
          systemInstruction: systemPrompt,
        });
        // Pass abort signal to the request
        const result = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });
        clearTimeout(timeoutId);
        const response = await result.response;

        // Reset error count on success
        provider.consecutiveErrors = 0;

        return response.text();
      } else {
        const completion = await (
          provider.client as OpenAI
        ).chat.completions.create(
          {
            model: provider.model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt },
            ],
            temperature: 0.9,
            frequency_penalty: 0.4,
            presence_penalty: 0.3,
          },
          {
            signal: controller.signal,
          },
        );
        clearTimeout(timeoutId);

        // Reset error count on success
        provider.consecutiveErrors = 0;

        return completion.choices[0]?.message?.content || '';
      }
    } catch (error: any) {
      clearTimeout(timeoutId);

      // Track the error
      provider.consecutiveErrors++;
      provider.lastErrorAt = Date.now();
      provider.lastErrorType = error?.name || error?.code || 'unknown';

      // Convert abort to timeout error for clearer logging
      if (error?.name === 'AbortError') {
        const timeoutError = new Error(
          `Request timeout after ${this.REQUEST_TIMEOUT_MS}ms`,
        );
        (timeoutError as any).name = 'TimeoutError';
        (timeoutError as any).originalError = error;
        throw timeoutError;
      }

      throw error;
    }
  }
  // ══════════════════════════════════════════════════════════════
  // FIXED: Provider rotation with network error handling and delays
  // ══════════════════════════════════════════════════════════════
  private async generateWithProviderRotation(
    prompt: string,
    systemPrompt?: string,
  ): Promise<string> {
    const maxAttempts = this.apiProviders.length * 2; // Allow cycling through twice
    let lastError: any;
    let attemptCount = 0;
    while (attemptCount < maxAttempts) {
      attemptCount++;

      // Get next available provider
      const provider = this.getNextProvider();
      // Handle case where all providers are locked out
      if (!provider) {
        // Find the provider that will be available soonest
        const now = Date.now();
        let soonest: APIProvider | null = null;
        let shortestWait = Infinity;
        for (const p of this.apiProviders) {
          let waitTime = 0;

          if (p.rateLimitedUntil > now) {
            waitTime = p.rateLimitedUntil - now;
          } else if (p.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
            const timeSinceError = now - p.lastErrorAt;
            waitTime = Math.max(0, this.EXTENDED_LOCKOUT_MS - timeSinceError);
          }
          if (waitTime < shortestWait) {
            shortestWait = waitTime;
            soonest = p;
          }
        }
        if (soonest && shortestWait > 0) {
          // Cap wait time at 60 seconds
          const cappedWait = Math.min(shortestWait, 60000);
          this.logger.warn(
            `All providers locked out. Waiting ${Math.round(cappedWait / 1000)}s for ${soonest.type} provider...`,
          );
          await this.sleep(cappedWait);

          // Reset the soonest provider and try it
          soonest.rateLimitedUntil = 0;
          if (soonest.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
            soonest.consecutiveErrors = Math.floor(
              this.MAX_CONSECUTIVE_ERRORS / 2,
            );
          }
        }

        continue;
      }
      const providerIdx = this.apiProviders.indexOf(provider) + 1;

      try {
        this.logger.log(
          `Attempting with ${provider.type} provider #${providerIdx} (attempt ${attemptCount}/${maxAttempts})...`,
        );

        const result = await this.generateWithProvider(
          provider,
          prompt,
          systemPrompt,
        );
        return result;
      } catch (error: any) {
        lastError = error;

        const errorType = this.isRateLimitError(error)
          ? 'rate_limit'
          : this.isNetworkError(error)
            ? 'network'
            : this.isOverloadError(error)
              ? 'overload'
              : 'other';
        this.logger.warn(
          `${provider.type} provider #${providerIdx} failed (${errorType}): ${error?.message?.substring(0, 100)}`,
        );
        // Handle based on error type
        if (this.isRateLimitError(error)) {
          // Lock out for rate limit
          provider.rateLimitedUntil = Date.now() + this.RATE_LIMIT_LOCKOUT_MS;
          this.logger.warn(
            `Provider #${providerIdx} rate limited, locked out for ${this.RATE_LIMIT_LOCKOUT_MS / 1000}s`,
          );
        } else if (this.isNetworkError(error)) {
          // Network errors: short lockout, then retry
          const lockoutMs = this.addJitter(5000); // ~5s lockout
          provider.rateLimitedUntil = Date.now() + lockoutMs;
          this.logger.warn(
            `Provider #${providerIdx} network error, brief lockout for ${Math.round(lockoutMs / 1000)}s`,
          );
        } else if (this.isOverloadError(error)) {
          // Overload: medium lockout
          const lockoutMs = this.addJitter(30000); // ~30s lockout
          provider.rateLimitedUntil = Date.now() + lockoutMs;
          this.logger.warn(
            `Provider #${providerIdx} overloaded, locked out for ${Math.round(lockoutMs / 1000)}s`,
          );
        }
        // Check if we should continue trying
        if (this.isRetryableError(error) && attemptCount < maxAttempts) {
          // Add delay before trying next provider (with jitter)
          const switchDelay = this.addJitter(this.PROVIDER_SWITCH_DELAY_MS);
          this.logger.debug(
            `Waiting ${switchDelay}ms before trying next provider...`,
          );
          await this.sleep(switchDelay);
          continue;
        }
        // Non-retryable error or exhausted attempts
        if (!this.isRetryableError(error)) {
          this.logger.error(
            `Non-retryable error from provider #${providerIdx}:`,
            error,
          );
          throw error;
        }
      }
    }
    // All attempts exhausted
    this.logger.error(`All ${maxAttempts} provider attempts failed`);
    throw lastError || new Error('All providers failed');
  }
  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ═══════════════════════════════════════════════════════════════
  // Post-processing — uses domain-specific patterns
  // ═══════════════════════════════════════════════════════════════
  private humanizeText(text: string, contentType: ContentType): string {
    let result = text;

    const patterns = this.getAITellPatterns(contentType);
    for (const { pattern, replacement } of patterns) {
      result = result.replace(pattern, replacement);
    }

    result = result.replace(/ {2,}/g, ' ');
    result = result.replace(/\n{3,}/g, '\n\n');

    for (const uniformPattern of SENTENCE_UNIFORMITY_PATTERNS) {
      const matches = result.match(uniformPattern);
      if (matches && matches.length > 3) {
        this.logger.warn(
          `Detected ${matches.length} repetitive sentence patterns: "${matches[0].substring(0, 40)}..."`,
        );
      }
    }

    return result.trim();
  }

  // ═══════════════════════════════════════════════════════════════
  // Multi-turn refinement — domain-aware critique
  // ═══════════════════════════════════════════════════════════════
  private async generateAndRefine(
    prompt: string,
    contentType: ContentType,
    systemPrompt?: string,
  ): Promise<string> {
    const draft = await this.generateWithProviderRotation(prompt, systemPrompt);

    const refinePrompt =
      contentType === 'travel'
        ? this.getTravelRefinePrompt(draft)
        : this.getFarmingRefinePrompt(draft);

    const refined = await this.generateWithProviderRotation(
      refinePrompt,
      systemPrompt,
    );

    return this.humanizeText(refined, contentType);
  }

  private getTravelRefinePrompt(draft: string): string {
    return `Here is a draft chapter you wrote. Rewrite it to fix these specific issues:

1. Replace any generic phrases ("hidden gem", "vibrant culture", "bustling streets") with specific concrete details
2. Vary sentence length — mix 4-word punches with 20-word flowing descriptions
3. Cut any sentence that states the obvious or adds no new information
4. Make sure no two consecutive paragraphs start with the same word
5. Add one imperfect detail per section (a place that was closed, a dish that was too spicy, rain that ruined a plan) — real travel has friction
6. Remove any phrase that sounds like a tourism brochure
7. Replace vague sensory language ("beautiful view") with specific sensory details ("the limestone cliffs dropped straight into water so clear you could count pebbles at ten meters")

DRAFT TO REWRITE:
${draft}

Return ONLY the rewritten text. No commentary.`;
  }

  private getFarmingRefinePrompt(draft: string): string {
    return `Here is a draft chapter you wrote. Rewrite it to fix these specific issues:

1. Replace any corporate/academic phrases ("sustainable practices", "holistic approach", "best practices") with plain farmer talk
2. Vary sentence length — mix short direct instructions with longer explanations
3. Cut any sentence that states the obvious or adds no practical value
4. Make sure no two consecutive paragraphs start with the same word
5. Add one honest failure or mistake per section (a crop that didn't make it, an equipment breakdown, a technique that sounded good but didn't work) — real farming has setbacks
6. Remove any phrase that sounds like an agriculture textbook or government pamphlet
7. Replace vague advice ("ensure proper drainage") with specific instructions ("dig a 6-inch trench along the downhill side of each bed, angled at about 2% grade toward your collection point")
8. Add specific numbers where possible: pounds per acre, days to germination, cost per head, hours of labor

DRAFT TO REWRITE:
${draft}

Return ONLY the rewritten text. No commentary.`;
  }

  async generateText(
    prompt: string,
    {
      refine = false,
      systemPrompt,
      contentType = 'travel' as ContentType,
    }: {
      refine?: boolean;
      systemPrompt?: string;
      contentType?: ContentType;
    } = {},
  ): Promise<string> {
    let lastError: any;

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        this.logger.log(
          `Generating ${contentType} content (attempt ${attempt}/${this.MAX_RETRIES})...`,
        );

        let text: string;

        if (refine) {
          text = await this.generateAndRefine(
            prompt,
            contentType,
            systemPrompt,
          );
        } else {
          text = await this.generateWithProviderRotation(prompt, systemPrompt);
          text = this.humanizeText(text, contentType);
        }

        this.logger.log('Content generated successfully');
        return text;
      } catch (error: any) {
        lastError = error;
        const is503Error =
          error?.status === 503 || error?.message?.includes('overloaded');
        const is429Error =
          error?.status === 429 || error?.message?.includes('rate limit');

        if (is503Error || is429Error) {
          if (attempt < this.MAX_RETRIES) {
            const delay = this.INITIAL_RETRY_DELAY * Math.pow(2, attempt - 1);
            this.logger.warn(
              `All providers overloaded/rate limited (attempt ${attempt}/${this.MAX_RETRIES}). Retrying in ${delay}ms...`,
            );
            await this.sleep(delay);
            continue;
          }
        }

        this.logger.error('Error generating content:', error);
        throw error;
      }
    }

    this.logger.error(`All ${this.MAX_RETRIES} retry attempts failed`);
    throw lastError;
  }

  // ═══════════════════════════════════════════════════════════════
  // BOOK OUTLINE — Domain-aware structure
  // ═══════════════════════════════════════════════════════════════
  async generateBookOutline(
    title: string,
    subtitle: string,
    numberOfChapters: number,
  ): Promise<BookOutlineDto> {
    const contentType = this.detectContentType(title);

    const exampleTitles =
      contentType === 'travel'
        ? `
BAD section titles (too generic):
- "Exploring the Rich Culture"
- "Understanding Local Traditions"
- "A Journey Through History"

GOOD section titles (specific, interesting):
- "Why Everyone Argues About the Best Laksa"
- "The Rainy Season Isn't as Bad as You Think"
- "Getting Lost in Shinjuku (On Purpose)"`
        : `
BAD section titles (too generic):
- "Understanding Soil Health"
- "Exploring Sustainable Methods"
- "A Comprehensive Overview of Livestock"

GOOD section titles (specific, practical):
- "Why Your Tomatoes Keep Getting Blossom End Rot"
- "The Cheapest Fence That Actually Keeps Coyotes Out"
- "What Nobody Tells You About Raising Meat Birds"`;

    const prompt = `Create a detailed ${numberOfChapters}-chapter outline for a ${contentType === 'farming' ? 'farming/agriculture' : 'travel'} guide book.

Book Title: "${title}"
Subtitle: "${subtitle}"

REQUIREMENTS:
1. Generate EXACTLY ${numberOfChapters} chapters total
2. Chapter 1: Introduction
3. Chapters 2-${numberOfChapters - 1}: Main content chapters
4. Chapter ${numberOfChapters}: Conclusion
5. Each chapter should have 2 to 5 sections (vary it — not every chapter needs the same count)
6. Each section should have 2 to 4 subsections (vary these too)
7. Section and subsection titles should sound like a human wrote them — no generic filler
${exampleTitles}

OUTPUT FORMAT (JSON):
{
  "chapters": [
    {
      "chapterNumber": 1,
      "chapterTitle": "Introduction",
      "sections": [
        {
          "sectionTitle": "A specific interesting title",
          "subsections": ["Concrete topic 1", "Concrete topic 2", "Concrete topic 3"]
        }
      ]
    }
  ]
}

Generate ALL ${numberOfChapters} chapters. Return complete valid JSON.`;

    const outlineSystemPrompt =
      contentType === 'farming'
        ? 'You are a book editor specializing in practical farming and agriculture guides. Return only valid JSON.'
        : 'You are a book editor specializing in travel guide book structure. Return only valid JSON.';

    const response = await this.generateText(prompt, {
      systemPrompt: outlineSystemPrompt,
      contentType,
    });

    const cleanedResponse = response
      .replace(/\`\`\`json/g, '')
      .replace(/\`\`\`/g, '')
      .trim();

    let outline;
    try {
      outline = JSON.parse(cleanedResponse);
    } catch (error) {
      this.logger.error('Failed to parse outline JSON:', cleanedResponse);
      throw new Error('Invalid JSON response from AI model');
    }

    if (!outline.chapters || !Array.isArray(outline.chapters)) {
      throw new Error('Invalid outline structure: chapters array missing');
    }

    if (outline.chapters.length !== numberOfChapters) {
      this.logger.warn(
        `AI generated ${outline.chapters.length} chapters instead of ${numberOfChapters}. Adjusting...`,
      );

      if (outline.chapters.length < numberOfChapters) {
        throw new Error(
          `AI generated only ${outline.chapters.length} chapters instead of ${numberOfChapters}. Please retry.`,
        );
      }

      outline.chapters = outline.chapters.slice(0, numberOfChapters);
    }

    outline.chapters.forEach((chapter: ChapterOutline, idx: number) => {
      if (!chapter.sections || !Array.isArray(chapter.sections)) {
        throw new Error(`Chapter ${idx + 1} missing sections array`);
      }
      chapter.sections.forEach((section: any, secIdx: number) => {
        if (!section.subsections || !Array.isArray(section.subsections)) {
          throw new Error(
            `Chapter ${idx + 1}, Section ${secIdx + 1} missing subsections array`,
          );
        }
      });
    });

    return {
      title,
      subtitle,
      author: '',
      chapters: outline.chapters,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // INTRODUCTION — Separate prompts for Travel vs Farming
  // ═══════════════════════════════════════════════════════════════
  async generateIntroduction(
    title: string,
    subtitle: string,
    outline: BookOutlineDto,
  ): Promise<string> {
    const introChapter = outline.chapters.find((c) => c.chapterNumber === 1);
    const contentType = this.detectContentType(title);

    if (!introChapter) {
      throw new Error('Introduction chapter not found in outline');
    }

    const prompt =
      contentType === 'travel'
        ? this.buildTravelIntroPrompt(title, subtitle, introChapter)
        : this.buildFarmingIntroPrompt(title, subtitle, introChapter);

    return await this.generateText(prompt, {
      refine: true,
      contentType,
      systemPrompt: this.getSystemPrompt(contentType),
    });
  }

  private buildTravelIntroPrompt(
    title: string,
    subtitle: string,
    introChapter: ChapterOutline,
  ): string {
    return `Write the complete Introduction chapter for this travel guide:

Title: "${title}"
Subtitle: "${subtitle}"

Chapter Structure:
${JSON.stringify(introChapter, null, 2)}

STRUCTURE:
Write 15-20 paragraphs covering all sections and subsections from the outline
Vary paragraph length: some short (2 sentences), some longer (4-5 sentences)
Open with a specific moment or scene from arriving at the destination, not a generic welcome
Close the chapter with forward momentum — make readers want to turn the page
SENTENCE RHYTHM (critical for sounding human):

Mix short sentences (4-8 words) with medium (12-18 words) and occasional long (20-25 words)
Never start 3+ consecutive sentences the same way
Use fragments occasionally. Like this. They feel natural.
Throw in a one-word sentence now and then. Seriously.
TRAVEL-SPECIFIC DETAILS TO INCLUDE:

A specific arrival memory (airport, train station, border crossing)
First sensory impression of the place (smell, sound, heat, light)
A brief interaction with a local person (name them)
One honest warning or reality check
What makes this destination different from every other "top 10" list
EXAMPLE of the voice and rhythm we want (DO NOT copy this content, just match the style):
"""
I first landed in Chiang Mai on a Tuesday. The airport smelled like diesel and jasmine — an odd combination that somehow works. My guesthouse host, a retired teacher named Khun Sompong, picked me up in a truck that had seen better decades. He drove with one hand and pointed out temples with the other, narrating a city he clearly loved.

That was six years ago. I've been back eleven times since.

This isn't the guide that tells you to "experience the magic." There is no magic. There's heat, and traffic, and the best $1.50 noodle soup you'll ever eat at a stall with no name on a street you can't pronounce. That's better than magic. That's real.
"""

Write the complete Introduction chapter now:`;
  }

  private buildFarmingIntroPrompt(
    title: string,
    subtitle: string,
    introChapter: ChapterOutline,
  ): string {
    return `Write the complete Introduction chapter for this farming guide:

Title: "${title}"
Subtitle: "${subtitle}"

Chapter Structure:
${JSON.stringify(introChapter, null, 2)}

STRUCTURE:

Write 15-20 paragraphs covering all sections and subsections from the outline
Vary paragraph length: some short (2 sentences), some longer (4-5 sentences)
Open with a specific moment on the farm — early morning chores, first harvest, a mistake that taught you something — not a generic "welcome to farming"
Close with what the reader will be able to do after reading this book
SENTENCE RHYTHM (critical for sounding human):

Mix short sentences (4-8 words) with medium (12-18 words) and occasional long (20-25 words)
Never start 3+ consecutive sentences the same way
Use fragments occasionally. Like this. They feel natural.
One-word sentences work too. Honestly.
FARMING-SPECIFIC DETAILS TO INCLUDE:

A specific early morning or seasonal memory
A real mistake you made and what it cost (time, money, animals)
A specific tool, breed, or variety by name
One honest warning about what this work actually demands
What this guide covers that most farming books skip (the practical, hands-on stuff)


EXAMPLE of the voice and rhythm we want (DO NOT copy this content, just match the style):
"""
My first batch of meat chickens died on day three. All twenty-five of them. The brooder was too hot — I'd followed the internet's advice and cranked it to 95°F without checking the thermometer, which was off by twelve degrees. Expensive lesson. $87.50 in chicks, plus the feed I'd already bought.

That was nine years ago. I've raised over four thousand birds since.

This book isn't going to tell you farming is a beautiful lifestyle choice. Some mornings it is — frost on the fence posts, coffee steam mixing with your breath, the quiet before the rooster starts up. Other mornings you're pulling a dead lamb at 3 AM in freezing rain. Both of those are farming. This book covers both.
"""

Write the complete Introduction chapter now:`;
  }

  // ═══════════════════════════════════════════════════════════════
  // FORMAT ROTATION — Random selection for content variation
  // ═══════════════════════════════════════════════════════════════

  /**
   * Select a random chapter format for the entire book.
   * Call this ONCE when starting book generation, then pass the format
   * to all chapter generation calls.
   */
  public selectBookFormat(): ChapterFormat {
    const randomIndex = Math.floor(Math.random() * CHAPTER_FORMATS.length);
    const format = CHAPTER_FORMATS[randomIndex];
    this.logger.log(`Selected book format: ${format}`);
    return format;
  }

  /**
   * Get all available formats (useful for testing or manual selection)
   */
  public getAvailableFormats(): ChapterFormat[] {
    return [...CHAPTER_FORMATS];
  }

  // ═══════════════════════════════════════════════════════════════
  // CHAPTER CONTENT — Now with format rotation
  // ═══════════════════════════════════════════════════════════════
  async generateChapterContent(
    chapterOutline: ChapterOutline,
    bookTitle: string,
    bookSubtitle: string,
    format: ChapterFormat,
    contextData?: {
      // TRAVEL context
      currency?: string;
      landmarks?: string[];
      localNames?: string[];
      priceExamples?: string[];
      weatherNotes?: string;
      // FARMING context
      climate?: string;
      usdaZone?: string;
      soilType?: string;
      acreage?: string;
      breeds?: string[];
      varieties?: string[];
      suppliers?: string[];
      localPrices?: string[];
    },
  ): Promise<string> {
    const contentType = this.detectContentType(bookTitle);

    this.logger.log(
      `Generating chapter ${chapterOutline.chapterNumber} with format: ${format}`,
    );

    const prompt =
      contentType === 'travel'
        ? this.buildTravelChapterPrompt(
            chapterOutline,
            bookTitle,
            bookSubtitle,
            contextData,
            format,
          )
        : this.buildFarmingChapterPrompt(
            chapterOutline,
            bookTitle,
            bookSubtitle,
            contextData,
            format,
          );

    return await this.generateText(prompt, {
      refine: true,
      contentType,
      systemPrompt: this.getSystemPrompt(contentType),
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // TRAVEL CHAPTER PROMPTS — 4 Format Variants
  // ═══════════════════════════════════════════════════════════════

  private buildTravelChapterPrompt(
    chapterOutline: ChapterOutline,
    bookTitle: string,
    bookSubtitle: string,
    contextData?: any,
    format: ChapterFormat = 'SCENE_NARRATIVE',
  ): string {
    const contextBlock = contextData
      ? `
REAL-WORLD CONTEXT (use these specific details naturally in the text):
${contextData.currency ? `- Local currency: ${contextData.currency}` : ''}
${contextData.landmarks?.length ? `- Real landmarks: ${contextData.landmarks.join(', ')}` : ''}
${contextData.localNames?.length ? `- Local names/terms: ${contextData.localNames.join(', ')}` : ''}
${contextData.priceExamples?.length ? `- Real prices: ${contextData.priceExamples.join(', ')}` : ''}
${contextData.weatherNotes ? `- Weather: ${contextData.weatherNotes}` : ''}
`
      : '';

    const baseHeader = `Write Chapter ${chapterOutline.chapterNumber}: "${chapterOutline.chapterTitle}" for the travel guide "${bookTitle}: ${bookSubtitle}".

Chapter Structure:
${JSON.stringify(chapterOutline, null, 2)}
${contextBlock}

PURPOSE: This is a practical guide book. Every paragraph should help the reader plan, decide, or navigate.`;

    const formatInstructions = this.getTravelFormatInstructions(format);
    const sharedRules = this.getTravelSharedRules();

    return `${baseHeader}

${formatInstructions}

${sharedRules}

Write the complete chapter now:`;
  }

  private getTravelFormatInstructions(format: ChapterFormat): string {
    switch (format) {
      case 'SCENE_NARRATIVE':
        return `
WRITING FORMAT: SCENE-FIRST NARRATIVE
Structure each section by opening with a specific moment or scene, then unpack the practical details.

STRUCTURE:
- Write 25-28 paragraphs covering all sections and subsections
- NO bullet points, NO numbered lists — everything in flowing prose
- Open each section with a vivid 2-3 sentence scene: arriving somewhere, watching something happen, a conversation snippet
- After the scene, pivot to practical guidance that builds from what you showed
- End sections with a specific recommendation or warning

PARAGRAPH FLOW:
1. Scene opener (sensory, specific, in-the-moment)
2. Context paragraph (what this place/experience is)
3. Practical details (costs, hours, how to get there)
4. Insider tip or mistake to avoid
5. Transition or verdict before next section

SENTENCE RHYTHM:
- Scene sentences: short and punchy, present tense feel ("The door opens. Smoke and garlic hit you.")
- Info sentences: medium length, clear and direct
- Vary starters: a name, a time, "I", "The", a sensory detail, a question
- Use fragments in scene moments. Like this. They land harder.

EXAMPLE of this format (match structure, not content):
"""
The ticket window closes at 4:30, not 5. I found this out the hard way, watching the metal shutter come down while I was still three people back in line. The guard shrugged. Come back tomorrow.

The temple complex is worth the early alarm, but only if you actually get inside. Gates open at 6 AM, and the first hour is genuinely uncrowded — monks doing morning rounds, mist still clinging to the stupas. By 8 it's tour bus territory. By 10 you're shuffling in a queue.

Entry costs 500 baht for foreigners, 50 for locals. No way around this. Bring cash — the ticket booth doesn't take cards, and the nearest ATM is a 10-minute walk back toward the main road.
"""`;

      case 'DIRECT_INSTRUCTION':
        return `
WRITING FORMAT: DIRECT INSTRUCTION
Structure each section as clear, actionable guidance. Lead with what to do, follow with why and how.

STRUCTURE:
- Write 25-28 paragraphs covering all sections and subsections
- NO bullet points, NO numbered lists — everything in flowing prose, but with an imperative, instructional voice
- Open each section with a direct instruction or recommendation
- Follow with the reasoning, context, and specific details
- End sections with a clear verdict or next step

PARAGRAPH FLOW:
1. Direct instruction opener ("Go to X." / "Skip Y." / "Book this in advance.")
2. Why this matters (brief reasoning)
3. How to do it (specifics: costs, timing, logistics)
4. What can go wrong and how to avoid it
5. Verdict or priority statement

SENTENCE RHYTHM:
- Instruction sentences: short, imperative ("Book the night train." "Eat here." "Avoid the south entrance.")
- Explanation sentences: medium length, clear cause-and-effect
- Vary between command, statement, and occasional question
- One-word verdicts work: "Essential." "Optional." "Skip."

EXAMPLE of this format (match structure, not content):
"""
Book the ferry tickets a day ahead. The morning boats sell out by 7 AM during high season, and the afternoon crossings are rough — the wind picks up after noon and half the passengers get sick. I've done both. Morning is worth the early wake-up.

The main pier is a 15-minute walk from the town center, or 60 baht by songthaew if you flag one down on the main road. Don't pay more than 80. Drivers will ask for 150 — smile, say "60," and start walking. They'll honk you back.

Get to the pier by 6:30 AM. The ticket window opens at 6, and the line builds fast. Bring exact change — 450 baht per person, cash only.
"""`;

      case 'PROBLEM_SOLUTION':
        return `
WRITING FORMAT: PROBLEM-SOLUTION
Structure each section around a common traveler problem, question, or challenge, then provide the solution.

STRUCTURE:
- Write 25-28 paragraphs covering all sections and subsections
- NO bullet points, NO numbered lists — everything in flowing prose
- Open each section by naming a specific problem, frustration, or question travelers face
- Then deliver the solution with specific, actionable details
- End sections with validation that the solution works

PARAGRAPH FLOW:
1. Problem statement ("Most travelers waste their first morning..." / "The biggest mistake here is..." / "You'll hear conflicting advice about...")
2. Why this problem exists (brief context)
3. The solution (specific steps, recommendations)
4. How you know it works (personal experience or evidence)
5. Edge cases or alternatives

SENTENCE RHYTHM:
- Problem sentences: conversational, acknowledging frustration ("Here's the thing nobody mentions...")
- Solution sentences: confident, specific, instructional
- Validation sentences: brief, personal, convincing ("This saved me three hours." "Worth it.")
- Mix rhetorical questions into problem setups: "Sound familiar?"

EXAMPLE of this format (match structure, not content):
"""
The maps are wrong. Not a little wrong — seriously wrong. Google thinks the main market is a 10-minute walk from the station. It's actually 25 minutes, and the "shortcut" it suggests goes through a construction zone that's been closed for two years.

Here's what actually works: exit the station from the north side (follow signs for "Local Buses"), turn left, and walk until you hit the river. The market is along the water, not inland where the maps show it. Look for the red umbrellas.

This route takes 20 minutes at a normal pace, 15 if you're rushing. It's not the shortest distance on paper, but it's the fastest actual walking route with no backtracking.
"""`;

      case 'COMPARE_CONTRAST':
        return `
WRITING FORMAT: COMPARISON-CONTRAST
Structure each section around choices, trade-offs, and decisions. Help readers pick between options.

STRUCTURE:
- Write 25-28 paragraphs covering all sections and subsections
- NO bullet points, NO numbered lists — everything in flowing prose
- Open each section by framing a decision or presenting options
- Compare options honestly with specific trade-offs (cost, time, experience, convenience)
- End sections with a clear recommendation for different traveler types

PARAGRAPH FLOW:
1. Decision framing ("You have two options for getting there..." / "The question is whether to...")
2. Option A: what it offers, costs, drawbacks
3. Option B: what it offers, costs, drawbacks
4. Direct comparison on key factors
5. Verdict: who should choose what

SENTENCE RHYTHM:
- Framing sentences: set up the choice clearly
- Comparison sentences: balanced but opinionated ("A is cheaper but B is worth the extra cost if...")
- Verdict sentences: direct and confident ("For most travelers, pick A. If you have time, B.")
- Use "but" and "however" to pivot between options — don't hedge, compare

EXAMPLE of this format (match structure, not content):
"""
Two ways to reach the ruins: the tourist shuttle or the local bus. The shuttle costs 400 baht, leaves from your hotel at 8 AM, includes a guide who speaks English, and returns you by 2 PM. The local bus costs 35 baht, leaves from the east terminal every 30 minutes, takes twice as long, and drops you 800 meters from the entrance with no guide.

The shuttle is efficient. You'll see the highlights, hear the history, and check the box in five hours. The guide knows which photo spots are least crowded.

The local bus is an experience. You'll share seats with farmers, students, and monks. The ride takes 90 minutes instead of 40, but you'll see countryside the shuttle skips entirely.

My take: first-timers or short-trippers should take the shuttle. If you've got three or more days and want to feel the place rather than just see it, take the local bus at least one direction.
"""`;

      default:
        return this.getTravelFormatInstructions('SCENE_NARRATIVE');
    }
  }

  private getTravelSharedRules(): string {
    return `
GUIDE BOOK CONTENT RULES (apply regardless of format):
- Every section needs: what it is, how to get there, when to go, how long to spend, what it costs, and whether it's worth it
- Include specific prices, hours, and distances — approximate is fine, vague is not
- Give clear recommendations: "Go to X, skip Y" — don't just describe, advise
- Warn about common mistakes: "Most people arrive too late" or "Don't bother on Mondays"
- Offer alternatives: "If X is crowded, Y is five minutes away and half the price"
- Mention logistics: parking, tickets, queues, best entrance, what to bring
- Brief personal anecdotes ONLY when they illustrate something useful
- Include one local name or phrase per section that readers can actually use
- Sensory details should help readers recognize places: "look for the blue awning" not just "it smells nice"

PRACTICAL HONESTY:
- Say when something is overhyped or not worth the effort for most travelers
- Mention what's changed recently if relevant
- Acknowledge different traveler types: "If you have kids..." or "Solo travelers might prefer..."
- Be specific about difficulty: walking distances, stairs, heat exposure, crowds
- Warn about scams, hassles, or annoyances — briefly, without drama

WHAT TO AVOID:
- Don't describe places without telling readers what to DO there
- Don't tell stories that don't lead to advice
- Don't use "offers" as a verb ("the city offers...")
- Don't balance every negative with a positive — if something isn't worth it, say so
- Don't summarize sections or telegraph what's coming next
- Don't start more than one paragraph with "The"
- Don't end paragraphs with vague praise ("...and that's what makes it special")
- Don't say "whether you're a budget traveler or luxury seeker" — pick your audience
- Don't use difficult words/grammar when simple ones will do — "utilize" vs "use", "ameliorate" vs "fix"`;
  }

  // ═══════════════════════════════════════════════════════════════
  // FARMING CHAPTER PROMPTS — 4 Format Variants
  // ═══════════════════════════════════════════════════════════════

  private buildFarmingChapterPrompt(
    chapterOutline: ChapterOutline,
    bookTitle: string,
    bookSubtitle: string,
    contextData?: any,
    format: ChapterFormat = 'SCENE_NARRATIVE',
  ): string {
    const contextBlock = contextData
      ? `
REAL-WORLD CONTEXT (use these specific details naturally in the text):
${contextData.climate ? `- Climate/region: ${contextData.climate}` : ''}
${contextData.usdaZone ? `- USDA Zone: ${contextData.usdaZone}` : ''}
${contextData.soilType ? `- Soil type: ${contextData.soilType}` : ''}
${contextData.acreage ? `- Scale: ${contextData.acreage}` : ''}
${contextData.breeds?.length ? `- Breeds/animals: ${contextData.breeds.join(', ')}` : ''}
${contextData.varieties?.length ? `- Crop varieties: ${contextData.varieties.join(', ')}` : ''}
${contextData.suppliers?.length ? `- Suppliers: ${contextData.suppliers.join(', ')}` : ''}
${contextData.localPrices?.length ? `- Local prices: ${contextData.localPrices.join(', ')}` : ''}
`
      : '';

    const baseHeader = `Write Chapter ${chapterOutline.chapterNumber}: "${chapterOutline.chapterTitle}" for the farming guide "${bookTitle}: ${bookSubtitle}".

Chapter Structure:
${JSON.stringify(chapterOutline, null, 2)}
${contextBlock}

PURPOSE: This is a practical farming guide. Every paragraph should help the reader do something, decide something, or avoid a costly mistake.`;

    const formatInstructions = this.getFarmingFormatInstructions(format);
    const sharedRules = this.getFarmingSharedRules();

    return `${baseHeader}

${formatInstructions}

${sharedRules}

Write the complete chapter now:`;
  }

  private getFarmingFormatInstructions(format: ChapterFormat): string {
    switch (format) {
      case 'SCENE_NARRATIVE':
        return `
WRITING FORMAT: SCENE-FIRST NARRATIVE
Structure each section by opening with a specific farm moment or hands-on scenario, then unpack the practical details.

STRUCTURE:
- Write 25-28 paragraphs covering all sections and subsections
- NO bullet points, NO numbered lists — everything in flowing prose
- Open each section with a vivid farm moment: early morning chores, something going wrong, a seasonal task
- After the scene, pivot to practical guidance that builds from what you showed
- End sections with a specific recommendation, number, or warning

PARAGRAPH FLOW:
1. Scene opener (sensory, specific, showing the work)
2. What this task/technique is and why it matters
3. Practical details (costs, timing, materials, steps)
4. What can go wrong and how to prevent it
5. Verdict or key number before next section

SENTENCE RHYTHM:
- Scene sentences: short and grounded ("The thermometer read 42°F. Too cold.")
- Info sentences: medium length, clear and direct
- Vary starters: a time of day, a season, a tool name, "I", "The", a number
- Use fragments in scene moments. They hit harder.

EXAMPLE of this format (match structure, not content):
"""
The first chick was dead by morning. I found her belly-up under the lamp, the others huddled in the opposite corner. The brooder was 104°F — ten degrees too hot. I'd trusted the lamp rating instead of checking the thermometer at chick height.

Brooder temperature matters more than almost anything else in the first week. Chicks can't regulate their body heat, so they depend entirely on your setup. Get this wrong and you'll lose birds to cold or heat.

Target 95°F directly under the heat source for day-old chicks, dropping 5 degrees per week until you hit 70°F or they're fully feathered. Measure at chick height — 2 inches off the bedding — not at lamp level.
"""`;

      case 'DIRECT_INSTRUCTION':
        return `
WRITING FORMAT: DIRECT INSTRUCTION
Structure each section as clear, actionable guidance. Lead with what to do, follow with why and how.

STRUCTURE:
- Write 25-28 paragraphs covering all sections and subsections
- NO bullet points, NO numbered lists — everything in flowing prose, but with an imperative, instructional voice
- Open each section with a direct instruction or action step
- Follow with the reasoning, materials needed, and specific details
- End sections with a cost, timeline, or measurable outcome

PARAGRAPH FLOW:
1. Direct instruction opener ("Set up your brooder three days before chicks arrive." / "Test your soil before buying amendments.")
2. Why this matters (brief reasoning, what goes wrong if you skip it)
3. How to do it (specific steps, materials, costs)
4. Common mistakes at this step
5. Success indicator or checkpoint

SENTENCE RHYTHM:
- Instruction sentences: short, imperative ("Order chicks in January." "Check daily." "Don't skip this.")
- Explanation sentences: medium length, clear cause-and-effect
- Mix commands, statements, and occasional questions
- One-word verdicts: "Essential." "Optional." "Overkill."

EXAMPLE of this format (match structure, not content):
"""
Order your chicks eight weeks before you want them. Hatcheries book up fast, especially for popular breeds in spring. Wait until March to order April chicks and you'll get whatever's left — often not what you wanted.

Most hatcheries require a 15-25 chick minimum to ship safely. The birds keep each other warm in transit. If you only want six layers, find a local farm selling started pullets instead.

Expect to pay $3-5 per chick for common laying breeds, $5-8 for meat birds, and $8-15 for heritage or rare breeds. Shipping adds $15-40 depending on distance. Budget $80-120 total for a starter flock of 25 birds.
"""`;

      case 'PROBLEM_SOLUTION':
        return `
WRITING FORMAT: PROBLEM-SOLUTION
Structure each section around a common farming problem, mistake, or challenge, then provide the solution.

STRUCTURE:
- Write 25-28 paragraphs covering all sections and subsections
- NO bullet points, NO numbered lists — everything in flowing prose
- Open each section by naming a specific problem farmers face (especially beginners)
- Then deliver the solution with specific, actionable details and numbers
- End sections with validation that the solution works

PARAGRAPH FLOW:
1. Problem statement ("Most beginners lose birds because..." / "The expensive mistake here is...")
2. Why this problem happens (root cause, what people get wrong)
3. The solution (specific steps, materials, costs)
4. How you know it works (personal experience, numbers)
5. Prevention or early warning signs

SENTENCE RHYTHM:
- Problem sentences: conversational, acknowledging frustration ("Ask me how I know this.")
- Solution sentences: confident, specific, numbers-heavy
- Validation sentences: brief, personal ("This cut my losses by 80%." "Worth it.")
- Use rhetorical questions to set up problems: "Ever wonder why your tomatoes crack after rain?"

EXAMPLE of this format (match structure, not content):
"""
New chicken keepers lose more birds to predators in the first month than in the entire rest of the year. The coop looks secure. The run seems solid. Then you wake up to feathers and a hole you didn't notice under the fence.

The problem is thinking like a human. You see a fence. A raccoon sees a puzzle. They'll dig under, climb over, reach through gaps you didn't know existed.

The solution is hardware cloth and an apron. Use 1/2-inch hardware cloth on all openings. Bury a 12-inch apron extending outward from the base of your run. Animals dig at the fence line, hit the apron, and give up.
"""`;

      case 'COMPARE_CONTRAST':
        return `
WRITING FORMAT: COMPARISON-CONTRAST
Structure each section around choices, methods, and trade-offs. Help readers pick the right approach for their situation.

STRUCTURE:
- Write 25-28 paragraphs covering all sections and subsections
- NO bullet points, NO numbered lists — everything in flowing prose
- Open each section by framing a decision or presenting method options
- Compare options honestly with specific trade-offs (cost, labor, results, scale)
- End sections with a clear recommendation for different farm situations

PARAGRAPH FLOW:
1. Decision framing ("Two approaches to this..." / "You'll need to choose between...")
2. Option A: what it involves, costs, labor, results
3. Option B: what it involves, costs, labor, results
4. Direct comparison on key factors (cost, time, effectiveness)
5. Verdict: who should choose what based on scale, budget, experience

SENTENCE RHYTHM:
- Framing sentences: set up the choice clearly
- Comparison sentences: balanced but opinionated ("A costs less but B saves time long-term")
- Verdict sentences: direct and specific ("Under 25 birds, choose A. Scaling up? B pays off.")
- Use "but" and "however" to pivot between options — don't hedge, compare honestly

EXAMPLE of this format (match structure, not content):
"""
Two feeding strategies for layers: free-choice or rationed. Free-choice means keeping feeders full 24/7 and letting birds eat whenever they want. Rationed means measuring out a specific amount per bird per day.

Free-choice is simpler. Less daily work, no measuring. The downside: you'll use 10-15% more feed, and some birds will overeat while others get pushed out.

Rationed feeding takes more effort but more control. You'll know exactly what each bird consumes, spot health problems faster, and reduce waste to near zero.

For backyard flocks under 20 birds, free-choice makes sense. Over 50 birds, rationing starts paying for itself. Between 20-50, it depends on how often you're out there anyway.
"""`;

      default:
        return this.getFarmingFormatInstructions('SCENE_NARRATIVE');
    }
  }

  private getFarmingSharedRules(): string {
    return `
GUIDE BOOK CONTENT RULES (apply regardless of format):
- Every section needs: what to do, when to do it, what it costs, what equipment you need, and what can go wrong
- Specific numbers always: pounds, days, dollars, temperatures, spacing, quantities — approximate is fine, vague is not
- Give clear recommendations: "Start with X, not Y" — don't just explain options, advise
- Include timing tied to season or growth stage: "transplant when seedlings have 4 true leaves" not "when ready"
- Cost breakdowns: materials, time investment, expected yield or return
- Warn about common beginner mistakes and what they cost
- Compare methods with honest trade-offs: "A is cheaper but takes twice as long"
- Mention specific breeds, varieties, or brands when it matters — and say why
- Personal anecdotes ONLY when they illustrate a mistake to avoid or a technique that works

PRACTICAL HONESTY:
- Say when something is overly complicated for the benefit
- Acknowledge scale: "This makes sense above 50 birds, not worth it for a small flock"
- Be honest about labor: "Plan on 30 minutes daily" or "This is a two-person job"
- Mention what wears out, breaks, or needs replacing
- Give the math: startup cost vs. ongoing cost vs. expected return
- Warn about regulations, permits, or processing requirements when relevant

WHAT TO AVOID:
- Don't explain concepts without telling readers what to DO with the information
- Don't tell failure stories without the lesson and the fix
- Don't use "journey" or "adventure" or "rewarding" — show the work, skip the sentiment
- Don't hedge when you know the answer: "tomatoes need full sun" not "may benefit from"
- Don't balance every negative with a positive — if something isn't worth it, say so
- Don't start more than one paragraph with "The"
- Don't end paragraphs with broad philosophy — end with specific action or assessment
- Don't say "it depends" without then explaining what it depends ON
- Don't use difficult words/grammar when simple ones will do — "utilize" vs "use", "ameliorate" vs "fix"`;
  }

  // ═══════════════════════════════════════════════════════════════
  // CONCLUSION — Separate prompts for Travel vs Farming
  // ═══════════════════════════════════════════════════════════════
  async generateConclusion(
    title: string,
    subtitle: string,
    outline: BookOutlineDto,
  ): Promise<string> {
    const conclusionChapter = outline.chapters.find(
      (c) => c.chapterNumber === outline.chapters.length,
    );
    const contentType = this.detectContentType(title);

    if (!conclusionChapter) {
      throw new Error('Conclusion chapter not found in outline');
    }

    const prompt =
      contentType === 'travel'
        ? this.buildTravelConclusionPrompt(title, subtitle, conclusionChapter)
        : this.buildFarmingConclusionPrompt(title, subtitle, conclusionChapter);

    return await this.generateText(prompt, {
      refine: true,
      contentType,
      systemPrompt: this.getSystemPrompt(contentType),
    });
  }

  private buildTravelConclusionPrompt(
    title: string,
    subtitle: string,
    conclusionChapter: ChapterOutline,
  ): string {
    return `Write the Conclusion chapter for this travel guide:

Title: "${title}"
Subtitle: "${subtitle}"

Chapter Structure:
${JSON.stringify(conclusionChapter, null, 2)}

PURPOSE: This conclusion should be the chapter readers flip back to at the airport and in their hotel room. Consolidate the most useful practical information. This is reference material with personality, not a sentimental sendoff.

STRUCTURE:
- 18-20 paragraphs total
- Open with brief, grounding context (2-3 sentences max), then get to the useful content
- Mix flowing prose with clearly formatted reference sections
- Lists and quick-reference sections ARE appropriate here — this chapter gets used differently than the others
- Close with a short final paragraph (2-3 sentences) — confident, not sentimental

MUST-INCLUDE REFERENCE SECTIONS (use clear formatting):
1. BEFORE YOU GO checklist: documents, copies, apps to download, things to book ahead
2. PACKING ESSENTIALS: specific to this destination, not generic travel advice
3. QUICK PHRASES: 8-10 actually useful local phrases with pronunciation hints
4. MONEY TIPS: ATM advice, tipping norms, cash vs card, common scams
5. EMERGENCY CONTACTS: real phone numbers — police, tourist police, embassy, hospitals, your country's emergency line
6. LAST-MINUTE REMINDERS: things easily forgotten, based on common mistakes

CONTENT APPROACH:
- Prioritize what readers will actually reference mid-trip
- Be specific: "download Grab before you land" not "consider ride-sharing apps"
- Include the non-obvious: what to photocopy, which cards work, what's closed on which days
- Quick verdicts on common questions: "Is the tourist bus worth it? No. Here's why."
- Acknowledge different trip lengths: "If you only have 3 days, prioritize X"
- One brief "I wish I'd known" paragraph — 3-4 specific things, not a long list

WHAT TO AVOID:
- Don't open with "In conclusion" or "As we come to the end" or "As your journey winds down"
- Don't summarize what the book covered chapter by chapter
- Don't use "whether you're a first-time visitor or returning traveler"
- Don't end with "safe travels" or "bon voyage" or similar
- Don't make the final paragraph about how the destination "will stay with you forever"
- Don't pad with generic advice that applies to all travel everywhere
- Don't use difficult words/grammar when simple ones will do — "utilize" vs "use", "ameliorate" vs "fix"


TONE:
- Helpful friend handing you notes before you leave
- Confident, direct, practical
- Brief personal touches only when they reinforce useful points
- Final paragraph: leave them ready to go, not misty-eyed

EXAMPLE of conclusion voice (match tone and utility, not content):
"""
You've read the chapters. Here's what to have ready when you land.

BEFORE YOU GO
- Passport valid 6+ months past return date. They check.
- Photo of passport info page on your phone AND emailed to yourself
- Grab app downloaded and account set up (needs a phone number — do this at home)
- Hotel first night booked with confirmation you can show offline
- Small bills ready — 500 baht in 100s and 20s for the first taxi and tips

PHRASES THAT ACTUALLY HELP
- "Khob khun khrap/kha" (thank you, male/female) — use constantly
- "Tao rai?" (how much?) — point at item, say this, they'll type it on a calculator
- "Mai phet" (not spicy) — though honestly, their "not spicy" is still pretty spicy
- "Check bin" (the bill, please) — mime signing if they don't hear you

[...continues with other reference sections...]

The rest you'll figure out as you go. That's most of the fun anyway.
"""

Write the complete Conclusion chapter now:`;
  }

  private buildFarmingConclusionPrompt(
    title: string,
    subtitle: string,
    conclusionChapter: ChapterOutline,
  ): string {
    return `Write the Conclusion chapter for this farming guide:

Title: "${title}"
Subtitle: "${subtitle}"

Chapter Structure:
${JSON.stringify(conclusionChapter, null, 2)}

PURPOSE: This conclusion should be the chapter readers flip back to repeatedly — during planning, during their first season, when something goes wrong. Consolidate the most useful practical information into clear reference sections. This is a working document, not a motivational speech.

STRUCTURE:
- 18-20 paragraphs total
- Open with brief, grounding context (2-3 sentences max), then get to the useful content
- Mix flowing prose with clearly formatted reference sections
- Lists, timelines, and quick-reference sections ARE appropriate here — this chapter gets used differently
- Close with a short final paragraph (2-3 sentences) — practical and honest

MUST-INCLUDE REFERENCE SECTIONS (use clear formatting):
1. FIRST YEAR PRIORITIES: What to do first, second, third — with reasoning. Not everything at once.
2. STARTUP COSTS REALITY CHECK: Actual numbers for basic setup, broken into categories. Include the things people forget to budget.
3. SEASONAL TIMELINE: Month-by-month or season-by-season key tasks. Specific dates/windows where relevant (adjust for zones).
4. COMMON FIRST-YEAR MISTAKES: 5-7 specific mistakes with what they cost and how to avoid them
5. WHEN SOMETHING GOES WRONG: Quick troubleshooting reference — symptoms and likely causes for common problems
6. RESOURCES: Where to buy supplies, extension office resources, local options

CONTENT APPROACH:
- Prioritize what readers will actually reference mid-season when stressed
- Be specific: "Order chicks by February for April delivery" not "plan ahead"
- Include the math: break-even points, cost per unit, expected yields
- Honest timelines: "Expect your first profitable year in year 1-2, not 6 months"
- Acknowledge scale: different advice for different operation sizes
- One brief "what I'd do differently" paragraph — 3-4 specific things, lessons learned

WHAT TO AVOID:
- Don't open with "In conclusion" or "As we come to the end" or "Now that you've learned"
- Don't summarize what the book covered chapter by chapter
- Don't say "farming is a journey" or "rewarding lifestyle" or "connection to the land"
- Don't end with inspirational quotes or sentiments about the farming life
- Don't pad with philosophy — every paragraph should contain usable information
- Don't use "sustainable" or "holistic" without specific meaning
- Don't use difficult words/grammar when simple ones will do — "utilize" vs "use", "ameliorate" vs "fix"

TONE:
- Experienced neighbor giving you their notes before your first season
- Confident, direct, practical
- Honest about difficulty without being discouraging
- Final paragraph: leave them ready to start, not inspired but vague

EXAMPLE of conclusion voice (match tone and utility, not content):
"""
You've got the information. Here's how to actually start.

FIRST YEAR PRIORITIES
1. Soil test before you buy anything else. $15 through your extension office. Saves hundreds in wrong amendments.
2. Start smaller than you think. Half your planned garden size. Quarter your planned flock. Scale up year two.
3. One enterprise at a time. Chickens OR a big garden. Not both. Not yet.
4. Infrastructure before animals. Fencing, shelter, water — all working before anything living arrives.

STARTUP COSTS (small laying flock, 12-15 birds)
- Chicks: $40-50 (order from hatchery, not feed store — better selection, healthier birds)
- Brooder setup: $50-60 (lamp, waterer, feeder, bedding)
- Coop: $200-800 depending on build vs buy (budget $400 for decent prefab or materials)
- Fencing: $150-300 for basic run
- Feed (first 6 months to laying): $80-100
- Total to first egg: $500-900 realistically
- Often forgotten: heat bulb replacements, medication, the second waterer you'll need

[...continues with other reference sections...]

Start with what you can manage. Add complexity later. That's the whole strategy.
"""

Write the complete Conclusion chapter now:`;
  }

  // ═══════════════════════════════════════════════════════════════
  // ABOUT BOOK — Domain-aware
  // ═══════════════════════════════════════════════════════════════
  async generateAboutBook(title: string, subtitle: string): Promise<string> {
    const contentType = this.detectContentType(title);

    const prompt =
      contentType === 'travel'
        ? `Write an "About This Book" blurb for a travel guide titled "${title}" and subtitle "${subtitle}".

4-6 short paragraphs. NO generic phrases like "comprehensive guide" or "everything you need to know."

Instead, be specific about:
- The angle this guide takes (what it covers that other travel books skip)
- Who will get the most out of it (solo backpackers? families? first-timers? repeat visitors?)
- One honest limitation ("This book won't..." or "If you're looking for luxury resort reviews, that's not this")
- How it's organized for actual trip planning, not armchair reading

Tone: confident, direct, slightly informal. Like a back-cover blurb written by the author, not a marketer.`
        : `Write an "About This Book" blurb for a farming guide titled "${title}" and subtitle "${subtitle}".

4-6 short paragraphs. NO generic phrases like "comprehensive guide" or "everything you need to know."

Instead, be specific about:
- The angle this guide takes (hands-on and practical, not academic theory)
- Who will get the most out of it (beginners? small-scale? specific livestock or crop focus?)
- One honest limitation ("This book won't..." or "If you're running a 500-acre commercial operation, scale up the numbers")
- How it's organized for actually getting started, not just reading about it

Tone: confident, direct, practical. Like a back-cover blurb written by someone who actually farms, not a publisher.`;

    return await this.generateText(prompt, {
      refine: false,
      contentType,
      systemPrompt: this.getSystemPrompt(contentType),
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // TABLE OF CONTENTS + COPYRIGHT (unchanged, domain-agnostic)
  // ═══════════════════════════════════════════════════════════════
  async generateTableOfContents(outline: BookOutlineDto): Promise<string> {
    if (!outline || !outline.chapters || !Array.isArray(outline.chapters)) {
      this.logger.error('Invalid outline structure:', outline);
      throw new Error('Invalid outline: chapters array is missing or invalid');
    }

    let toc = 'Table of Contents\n\n';

    outline.chapters.forEach((chapter) => {
      if (!chapter) {
        this.logger.warn('Skipping undefined chapter in TOC generation');
        return;
      }

      toc += `Chapter ${chapter.chapterNumber}\n`;
      toc += `${chapter.chapterTitle}\n\n`;

      if (chapter.sections && Array.isArray(chapter.sections)) {
        chapter.sections.forEach((section) => {
          if (!section) {
            this.logger.warn('Skipping undefined section in TOC generation');
            return;
          }

          toc += `  ${section.sectionTitle}\n`;

          if (section.subsections && Array.isArray(section.subsections)) {
            section.subsections.forEach((subsection) => {
              if (subsection) {
                toc += `    ${subsection}\n`;
              }
            });
          }
          toc += '\n';
        });
      }
      toc += '\n';
    });

    return toc;
  }

  async generateCopyright(author: string, year: number): Promise<string> {
    return `Copyright © 2026 ${author}. All rights reserved.

No part of this book may be reproduced, stored in a research system, or transmitted in any form or by any means, electronic, mechanical, photocopying, recording, or otherwise, without the prior written permission of the publisher, except for the use of brief quotations in a review or academic work.`;
  }
}
