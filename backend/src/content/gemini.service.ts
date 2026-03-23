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

PURPOSE: This introduction should orient readers and set expectations. Establish your credibility quickly, explain what this guide covers (and doesn't), and help readers understand how to use it. This is the setup for a practical guide, not the opening of a memoir.

STRUCTURE:
- Write 15-20 paragraphs covering all sections and subsections from the outline
- Vary paragraph length: some short (2 sentences), some longer (4-5 sentences)
- Open with a brief grounding moment (3-4 sentences max) that establishes you've been there, then move to useful orientation
- Close with what readers can expect from the chapters ahead — practical setup, not inspirational sendoff

MUST COVER (weave naturally into the structure):
1. YOUR CREDIBILITY: How many times you've been, how long total, what you've actually done there — brief, factual, not boastful
2. WHAT THIS GUIDE IS: The specific angle or approach — budget? off-the-beaten-path? food-focused? first-timers? Be clear.
3. WHAT THIS GUIDE ISN'T: One honest sentence about what readers should look elsewhere for
4. WHO THIS IS FOR: The type of traveler who'll get the most value — be specific
5. HOW TO USE THIS BOOK: Quick guidance — read straight through? Jump to relevant chapters? Use as reference on the ground?
6. QUICK DESTINATION ORIENTATION: Geography basics, climate in brief, general vibe — help readers form a mental picture
7. HONEST EXPECTATIONS: What surprises most first-timers (good and bad), common misconceptions to correct
8. BEST TIME TO VISIT: Condensed, practical guidance with trade-offs for different seasons

SENTENCE RHYTHM (critical for sounding human):
- Mix short sentences (4-8 words) with medium (12-18 words) and occasional long (20-25 words)
- Never start 3+ consecutive sentences the same way
- Use fragments occasionally. Like this. They feel natural.
- One-word sentences work too. Rarely.

TONE:
- Confident expert who respects the reader's time
- Practical over poetic — save extended descriptions for the destination chapters
- Personal touches establish trust, not tell your story
- Direct about limitations and trade-offs

WHAT TO AVOID:
- Don't spend more than one paragraph on your personal arrival story
- Don't use "embark on a journey" or "discover the magic" or "this guide will be your companion"
- Don't promise the book has "everything you need to know" — be specific about what it covers
- Don't list what every chapter contains (that's what the table of contents is for)
- Don't use "whether you're a budget backpacker or luxury traveler" — pick your audience
- Don't end with "let's begin" or "turn the page to start your adventure"
- Don't use difficult words/grammar when simple ones will do — "utilize" vs "use", "ameliorate" vs "fix"


EXAMPLE of introduction voice (match practical tone, not content):
"""
I've spent eleven months total in Vietnam over six years — five extended trips, plus two where I was supposedly "just passing through" and stayed two extra weeks. I keep coming back because the food is extraordinary, the costs are low, and I still haven't run out of places that surprise me.

This guide is for independent travelers on a moderate budget — not backpacker hostels, not luxury resorts, but the comfortable middle where most people actually travel. If you want five-star spa recommendations, that's a different book. If you want a $6/night dorm guide, also a different book.

Here's what most first-timers get wrong: they try to cover too much ground. Vietnam is long and thin, and the 1,000-mile bus ride from Hanoi to Ho Chi Minh City is not the scenic adventure the brochures suggest. This guide is organized to help you pick a region and go deep rather than skim the whole country and see nothing properly.

Climate matters more than people expect. The north and south have completely different weather patterns, and "dry season" in one region is "wet season" in another. Chapter 2 breaks this down with month-by-month specifics for each region, because I got this wrong my first trip and spent a week in sideways rain.

Use this book however it helps. Read it straight through for trip planning, or jump to specific chapters once you've chosen your destinations. The practical details — prices, hours, transport options — are current as of late 2024, but Vietnam changes fast. Assume a 10-15% price increase on anything over a year old.
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

PURPOSE: This introduction should orient readers and set expectations. Establish your credibility quickly, explain what this guide covers (and doesn't), and help readers understand how to use it. This is the setup for a practical working guide, not a farming memoir.

STRUCTURE:
- Write 15-20 paragraphs covering all sections and subsections from the outline
- Vary paragraph length: some short (2 sentences), some longer (4-5 sentences)
- Open with a brief grounding moment (3-4 sentences max) that establishes real experience, then move to useful orientation
- Close with what readers will be able to do after working through this book — specific, practical outcomes

MUST COVER (weave naturally into the structure):
1. YOUR CREDIBILITY: How long you've been doing this, what scale, what you've actually raised or grown — brief, factual, include a failure that taught you something
2. WHAT THIS GUIDE IS: The specific angle — small-scale? beginner? specific animal/crop focus? hands-on practical? Be clear.
3. WHAT THIS GUIDE ISN'T: One honest sentence about what readers need a different resource for
4. WHO THIS IS FOR: Scale, experience level, goals — the reader who'll get the most value
5. HOW TO USE THIS BOOK: Read straight through? Use as seasonal reference? Start with specific chapter? Give guidance.
6. REALISTIC EXPECTATIONS: Time commitment, physical demands, learning curve — what most beginners underestimate
7. MONEY REALITY: Brief, honest framing of costs vs. returns and timeline to break-even — set expectations early
8. HOW THIS BOOK IS ORGANIZED: Brief logic of chapter flow so readers understand the progression

SENTENCE RHYTHM (critical for sounding human):
- Mix short sentences (4-8 words) with medium (12-18 words) and occasional long (20-25 words)
- Never start 3+ consecutive sentences the same way
- Use fragments occasionally. Like this. They feel natural.
- One-word sentences work too. Sometimes.

TONE:
- Experienced neighbor who's been through the learning curve
- Practical over philosophical — save detailed techniques for the working chapters
- Personal touches establish trust and credibility, not tell your life story
- Honest about difficulty without being discouraging

WHAT TO AVOID:
- Don't spend more than one paragraph on your origin story or how you "got into" farming
- Don't use "journey," "passion," "rewarding lifestyle," or "connection to the land"
- Don't promise the book covers "everything" — be specific about scope
- Don't list what every chapter contains (that's what the table of contents is for)
- Don't say "whether you have five acres or fifty" — pick your scale and own it
- Don't end with "let's get started" or "now let's dig in" or similar

WHAT TO AVOID:
- Don't open with "In conclusion" or "As we come to the end" or "Now that you've learned"
- Don't summarize what the book covered chapter by chapter
- Don't say "farming is a journey" or "rewarding lifestyle" or "connection to the land"
- Don't end with inspirational quotes or sentiments about the farming life
- Don't pad with philosophy — every paragraph should contain usable information
- Don't use "sustainable" or "holistic" without specific meaning
- Don't use difficult words/grammar when simple ones will do — "utilize" vs "use", "ameliorate" vs "fix"


EXAMPLE of introduction voice (match practical tone, not content):
"""
I've raised chickens for nine years, starting with twelve laying hens in a converted shed and scaling up to 200 meat birds per batch plus a flock of 40 layers. I've lost birds to heat, cold, predators, and my own mistakes. The first two years I barely broke even. Year three I finally started making money — small money, but real.

This guide is for small-scale poultry, which I'm defining as under 500 birds total at any time. If you're planning a commercial operation with thousands of birds, the economics and regulations are different enough that you need a different book. If you want three hens for backyard eggs, this is more than you need — but it'll work.

Most beginners underestimate two things: the daily time commitment and the startup costs. Chickens need attention every single day. No weekends off, no sleeping in. A basic laying flock setup runs $500-900 before you collect your first egg. This book gives you the real numbers throughout, because I wasted money on things I didn't need and skipped things I should have bought.

The chapters follow the order you'll actually need them: setup and infrastructure first, then getting your birds, then daily management, then problems and troubleshooting. If you're taking over an existing operation, you can probably skip to Chapter 4. If you're starting from bare ground, start at Chapter 1 and go straight through.

After working through this guide, you'll be able to set up housing, select and purchase appropriate birds, manage daily care, handle common health issues, and process or sell your product. You'll make mistakes — everyone does — but they'll be new mistakes, not the ones I already made for you.
"""

Write the complete Introduction chapter now:`;
  }

  // ═══════════════════════════════════════════════════════════════
  // CHAPTER CONTENT — Separate prompts for Travel vs Farming
  // ═══════════════════════════════════════════════════════════════
  async generateChapterContent(
    chapterOutline: ChapterOutline,
    bookTitle: string,
    bookSubtitle: string,
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

    const prompt =
      contentType === 'travel'
        ? this.buildTravelChapterPrompt(
            chapterOutline,
            bookTitle,
            bookSubtitle,
            contextData,
          )
        : this.buildFarmingChapterPrompt(
            chapterOutline,
            bookTitle,
            bookSubtitle,
            contextData,
          );

    return await this.generateText(prompt, {
      refine: true,
      contentType,
      systemPrompt: this.getSystemPrompt(contentType),
    });
  }

  private buildTravelChapterPrompt(
    chapterOutline: ChapterOutline,
    bookTitle: string,
    bookSubtitle: string,
    contextData?: any,
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

    return `Write Chapter ${chapterOutline.chapterNumber}: "${chapterOutline.chapterTitle}" for the travel guide "${bookTitle}: ${bookSubtitle}".

Chapter Structure:
${JSON.stringify(chapterOutline, null, 2)}
${contextBlock}

PURPOSE: This is a practical guide book. Every paragraph should help the reader plan, decide, or navigate. Personal anecdotes exist to illustrate useful points, not to tell your story.

STRUCTURE:
- Write 25-28 paragraphs covering all sections and subsections
- NO bullet points, NO numbered lists — everything in flowing prose
- Lead with the useful information, then add color or context
- Each paragraph should answer an implicit reader question: "What should I do?" "How much?" "When?" "Is it worth it?" "What's the catch?"

SENTENCE RHYTHM:
- Alternate: short sentence (4-8 words), then medium (12-18), then long (20-25), then short again
- Start sentences differently: a name, a place, "I", "The", a time, an action, a question
- Use occasional fragments for emphasis
- Rhetorical questions that voice what the reader is thinking: "Worth the detour?" "Too touristy?"
- Blunt verdicts: "Skip it." "This is overrated." "Go anyway."

GUIDE BOOK CONTENT RULES:
- Every section needs: what it is, how to get there, when to go, how long to spend, what it costs, and whether it's worth it
- Include specific prices, hours, and distances — approximate is fine, vague is not
- Give clear recommendations: "Go to X, skip Y" — don't just describe, advise
- Warn about common mistakes: "Most people arrive too late" or "Don't bother on Mondays"
- Offer alternatives: "If X is crowded, Y is five minutes away and half the price"
- Mention logistics: parking, tickets, queues, best entrance, what to bring
- Brief personal anecdotes ONLY when they illustrate something useful — not for flavor alone
- Include one local name or phrase per section that readers can actually use
- Sensory details should help readers recognize places: "look for the blue awning" not just "it smells nice"

PRACTICAL HONESTY:
- Say when something is overhyped or not worth the effort for most travelers
- Mention what's changed recently if relevant: "used to be quieter" or "prices jumped in 2024"
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
- Don't use difficult words/grammar when simple ones will do — "utilize" vs "use", "ameliorate" vs "fix"


EXAMPLE of voice (practical guide with personality):
"""
The morning market opens at five, but arrive by four-thirty if you want to see the fish auction. By six, the tourist crowds show up and prices double. Aunt Noi's shrimp stall — north side, near the ice truck — sells the freshest catch, but she won't bargain. Don't try.

Most guides tell you to come at sunrise for photos. Bad advice. The light is flat and the aisles are packed with tour groups. Come at four-thirty for the action, or come at seven-thirty when it's thinning out and you can actually move. Skip the sunrise middle ground.

Budget about 200 baht for a full breakfast — noodles, coffee, and a bag of fruit to take with you. The coffee stall on the north corner does condensed milk coffee that's aggressively sweet. Perfect if you need the energy, overwhelming if you don't. No seating — you stand or walk.
"""

Write the complete chapter now:`;
  }

  private buildFarmingChapterPrompt(
    chapterOutline: ChapterOutline,
    bookTitle: string,
    bookSubtitle: string,
    contextData?: any,
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

    return `Write Chapter ${chapterOutline.chapterNumber}: "${chapterOutline.chapterTitle}" for the farming guide "${bookTitle}: ${bookSubtitle}".

Chapter Structure:
${JSON.stringify(chapterOutline, null, 2)}
${contextBlock}

PURPOSE: This is a practical farming guide. Every paragraph should help the reader do something, decide something, or avoid a costly mistake. Personal experience illustrates useful points — it's not memoir.

STRUCTURE:
- Write 25-28 paragraphs covering all sections and subsections
- NO bullet points, NO numbered lists — everything in flowing prose
- Lead with the actionable information, then explain why or add context
- Each paragraph should answer: "How do I do this?" "What do I need?" "What will it cost?" "What goes wrong?" "What's the better option?"

SENTENCE RHYTHM:
- Alternate: short sentence (4-8 words), then medium (12-18), then long (20-25), then short again
- Start sentences differently: a time of day, a season, "I", "The", an animal name, a tool, a quantity
- Use occasional fragments for emphasis
- Rhetorical questions that voice what the reader is thinking: "Worth the extra cost?" "Too much work for a beginner?"
- Blunt verdicts: "Don't bother." "This pays for itself." "Overkill for small operations."

GUIDE BOOK CONTENT RULES:
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
- Don't use difficult words/grammar when simple ones will do — "utilize" vs "use", "ameliorate" vs "fix"


EXAMPLE of voice (practical guide with personality):
"""
Start your brooder setup three days before chicks arrive. Heat lamp on, thermometer at chick height, bedding down. You want 95°F directly under the lamp and room to escape to cooler edges. Check the thermometer, not the lamp wattage — ambient temperature matters more than you'd think.

Most first-timers set up the day chicks arrive. Bad idea. You're rushed, the temperature isn't stable, and you lose chicks to cold corners before you've figured out the problem. I lost eight of twenty-five my first batch this way. $28 in dead birds, plus the stress.

Budget $45-60 for a basic brooder setup: heat lamp ($15), bulb ($10), thermometer ($8), waterer ($7), feeder ($8), and pine shavings ($6 for a bale that lasts weeks). Don't cheap out on the thermometer. The $3 ones drift. The $8 digital ones hold calibration and save you birds.
"""

Write the complete chapter now:`;
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

PURPOSE: This is the back-cover or first-page blurb that helps readers decide if this book is right for them. It should be honest, specific, and useful — not marketing copy. Think: "Here's exactly what you're getting."

LENGTH: 4-6 short paragraphs (200-300 words total)

MUST INCLUDE:
1. THE ANGLE: What specific approach does this guide take? Budget-focused? Food-focused? Off-the-beaten-path? First-timers? Be concrete about the perspective.
2. THE AUTHOR'S CREDIBILITY: One sentence — how many trips, how much time on the ground, what kind of travel. Factual, not boastful.
3. WHO IT'S FOR: Specific traveler type who'll get the most value. Pick one primary audience.
4. WHO IT'S NOT FOR: One honest line — "If you want luxury resort reviews, look elsewhere" or "Not for package tourists."
5. WHAT'S DIFFERENT: One specific thing this guide covers that most travel books skip or get wrong.
6. HOW IT'S ORGANIZED: One sentence on structure that helps readers know what to expect.

WHAT TO AVOID:
- "Comprehensive guide" or "everything you need to know" or "ultimate guide"
- "Whether you're a first-timer or seasoned traveler" — pick one
- "Embark on a journey" or "discover the magic" or "hidden gems await"
- "This book will be your companion" or similar
- Generic praise for the destination ("stunning beaches," "rich culture")
- Ending with "start planning your trip today" or any call-to-action

TONE: Confident, direct, slightly informal. Like the author wrote it, not a marketing department.

EXAMPLE (match tone and specificity, not content):
"""
This is a budget guide to Portugal for independent travelers — specifically, people spending $50-80/day who want good food, real neighborhoods, and no tour buses.

I've spent seven months total in Portugal over four trips, mostly in Lisbon and Porto but with enough time in the Alentejo and Algarve to know which beach towns are worth the detour and which are overrun. This guide reflects what I actually did, not what the tourism board wants you to do.

If you're looking for five-star hotel reviews or spa recommendations, this isn't it. If you want to know which tram is worth the wait and which is a tourist trap, which markets have real food vs. staged photo ops, and how to eat extremely well for under €15 — that's what this covers.

Organized by region, then by practical category: where to sleep, where to eat, what to see, what to skip. Use it to plan or carry it with you. It works either way.
"""

Write the About This Book blurb now:`
        : `Write an "About This Book" blurb for a farming guide titled "${title}" and subtitle "${subtitle}".

PURPOSE: This is the back-cover or first-page blurb that helps readers decide if this book is right for them. It should be honest, specific, and useful — not marketing copy. Think: "Here's exactly what you're getting."

LENGTH: 4-6 short paragraphs (200-300 words total)

MUST INCLUDE:
1. THE ANGLE: What specific approach does this guide take? Hands-on practical? Beginner-focused? Small-scale? Specific region or climate? Be concrete about the perspective.
2. THE AUTHOR'S CREDIBILITY: One sentence — years of experience, scale of operation, what you've actually raised or grown. Factual, not boastful.
3. WHO IT'S FOR: Specific reader type who'll get the most value. Pick one primary audience — scale, experience level, goals.
4. WHO IT'S NOT FOR: One honest line — "If you're running a commercial 500-acre operation, scale up the numbers" or "Not for hobby farmers who want three chickens."
5. WHAT'S DIFFERENT: One specific thing this guide covers that most farming books skip or bury in theory.
6. HOW IT'S ORGANIZED: One sentence on structure — follows seasonal order? project-based? skill progression?

WHAT TO AVOID:
- "Comprehensive guide" or "everything you need to know" or "complete handbook"
- "Whether you have one acre or one hundred" — pick a scale
- "Sustainable," "holistic," "rewarding journey," "connection to the land"
- "Transform your homestead" or "unlock your farm's potential"
- Generic farming romanticism ("fresh eggs every morning," "the satisfaction of growing your own")
- Ending with "start your farming journey today" or any call-to-action

TONE: Confident, direct, practical. Like someone who actually does this work wrote it, not a publisher.

EXAMPLE (match tone and specificity, not content):
"""
This is a practical guide to raising meat chickens on a small scale — 25 to 200 birds at a time, processed on-farm or at a local facility, sold direct or raised for your own freezer.

I've raised over 4,000 meat birds in nine years, starting with a disastrous first batch and gradually figuring out what actually works. This guide is the book I wish I'd had: less theory, more "here's exactly what to buy, build, and do."

If you want a commercial broiler operation with 10,000 birds, this isn't it — the economics and infrastructure are different at that scale. If you want a chapter on chicken history and heritage breed philosophy, also not here. This is about getting birds from hatchery to freezer without losing money or your sanity.

Organized by the timeline you'll actually follow: setup first, then brooding, then growing, then processing, then the business side. Each chapter has costs, timelines, and the mistakes I made so you don't have to.
"""

Write the About This Book blurb now:`;

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
