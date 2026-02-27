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
  private readonly PROVIDER_COOLDOWN_MS = 2000; // Min 2s between calls to same key
  private readonly RATE_LIMIT_LOCKOUT_MS = 60000; // Lock out for 60s after 429

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
      });
    }
  }

  private getNextProvider(): APIProvider | null {
    const now = Date.now();
    const available = this.apiProviders.filter(
      (p) => now >= p.rateLimitedUntil,
    );
    if (available.length === 0) return null;
    // Pick the one that has been idle the longest
    available.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
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

  // ═══════════════════════════════════════════════════════════════
  // Provider calls with system prompt + generation config
  // ═══════════════════════════════════════════════════════════════
  private async generateWithProvider(
    provider: APIProvider,
    prompt: string,
    systemPrompt: string = TRAVEL_SYSTEM_PROMPT,
  ): Promise<string> {
    await this.waitForProviderCooldown(provider);
    provider.lastUsedAt = Date.now();

    if (provider.type === 'gemini') {
      const model = (provider.client as GoogleGenerativeAI).getGenerativeModel({
        model: provider.model,
        generationConfig: {
          temperature: 1.0,
          topP: 0.92,
          topK: 50,
          maxOutputTokens: 8192,
        },
        systemInstruction: systemPrompt,
      });
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } else {
      const completion = await (
        provider.client as OpenAI
      ).chat.completions.create({
        model: provider.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        temperature: 0.9,
        frequency_penalty: 0.4,
        presence_penalty: 0.3,
      });
      return completion.choices[0]?.message?.content || '';
    }
  }

  private async generateWithProviderRotation(
    prompt: string,
    systemPrompt?: string,
  ): Promise<string> {
    const providersToTry = this.apiProviders.length;
    let lastError: any;

    for (let attempt = 0; attempt < providersToTry; attempt++) {
      // ── Use smart selection instead of blind round-robin ────
      const provider = this.getNextProvider();

      // ── Handle null: all providers are rate-limited ─────────
      if (!provider) {
        // Find the provider whose rate limit expires soonest
        const soonest = this.apiProviders.reduce((a, b) =>
          a.rateLimitedUntil < b.rateLimitedUntil ? a : b,
        );
        const waitTime = Math.max(0, soonest.rateLimitedUntil - Date.now());

        if (waitTime > 0) {
          this.logger.warn(
            `All providers rate-limited. Waiting ${waitTime}ms for ${soonest.type}...`,
          );
          await this.sleep(waitTime);
        }

        // After waiting, try with the soonest provider directly
        try {
          soonest.rateLimitedUntil = 0; // Reset its lockout
          return await this.generateWithProvider(soonest, prompt, systemPrompt);
        } catch (error) {
          lastError = error;
          throw error;
        }
      }

      // ── provider is guaranteed non-null from here ───────────
      try {
        const providerIdx = this.apiProviders.indexOf(provider) + 1;
        this.logger.log(
          `Attempting with ${provider.type} provider #${providerIdx} (attempt ${attempt + 1}/${providersToTry})...`,
        );
        return await this.generateWithProvider(provider, prompt, systemPrompt);
      } catch (error: any) {
        lastError = error;
        const isRateLimitError =
          error?.status === 429 ||
          error?.message?.includes('rate limit') ||
          error?.message?.includes('quota');

        if (isRateLimitError) {
          // ── Lock out this provider for 60 seconds ───────────
          provider.rateLimitedUntil = Date.now() + this.RATE_LIMIT_LOCKOUT_MS;
          this.logger.warn(
            `${provider.type} provider #${this.apiProviders.indexOf(provider) + 1} rate limited, locked out for ${this.RATE_LIMIT_LOCKOUT_MS / 1000}s`,
          );

          if (attempt < providersToTry - 1) {
            continue;
          }
        }

        throw error;
      }
    }

    throw lastError;
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
- Write 10-12 paragraphs covering all sections and subsections from the outline
- Vary paragraph length: some short (2 sentences), some longer (4-5 sentences)
- Open with a specific moment or scene from arriving at the destination, not a generic welcome
- Close the chapter with forward momentum — make readers want to turn the page

SENTENCE RHYTHM (critical for sounding human):
- Mix short sentences (4-8 words) with medium (12-18 words) and occasional long (20-25 words)
- Never start 3+ consecutive sentences the same way
- Use fragments occasionally. Like this. They feel natural.
- Throw in a one-word sentence now and then. Seriously.

TRAVEL-SPECIFIC DETAILS TO INCLUDE:
- A specific arrival memory (airport, train station, border crossing)
- First sensory impression of the place (smell, sound, heat, light)
- A brief interaction with a local person (name them)
- One honest warning or reality check
- What makes this destination different from every other "top 10" list

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
- Write 10-12 paragraphs covering all sections and subsections from the outline
- Vary paragraph length: some short (2 sentences), some longer (4-5 sentences)
- Open with a specific moment on the farm — early morning chores, first harvest, a mistake that taught you something — not a generic "welcome to farming"
- Close with what the reader will be able to do after reading this book

SENTENCE RHYTHM (critical for sounding human):
- Mix short sentences (4-8 words) with medium (12-18 words) and occasional long (20-25 words)
- Never start 3+ consecutive sentences the same way
- Use fragments occasionally. Like this. They feel natural.
- One-word sentences work too. Honestly.

FARMING-SPECIFIC DETAILS TO INCLUDE:
- A specific early morning or seasonal memory
- A real mistake you made and what it cost (time, money, animals)
- A specific tool, breed, or variety by name
- One honest warning about what this work actually demands
- What this guide covers that most farming books skip (the practical, hands-on stuff)

EXAMPLE of the voice and rhythm we want (DO NOT copy this content, just match the style):
"""
My first batch of meat chickens died on day three. All twenty-five of them. The brooder was too hot — I'd followed the internet's advice and cranked it to 95°F without checking the thermometer, which was off by twelve degrees. Expensive lesson. $87.50 in chicks, plus the feed I'd already bought.

That was nine years ago. I've raised over four thousand birds since.

This book isn't going to tell you farming is a beautiful lifestyle choice. Some mornings it is — frost on the fence posts, coffee steam mixing with your breath, the quiet before the rooster starts up. Other mornings you're pulling a dead lamb at 3 AM in freezing rain. Both of those are farming. This book covers both.
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

STRUCTURE:
- Write 23-25 paragraphs covering all sections and subsections
- NO bullet points, NO numbered lists — everything in flowing prose
- Open each section with a specific moment, scene, or anecdote
- Weave practical info into stories — don't just list facts

SENTENCE RHYTHM:
- Alternate: short sentence (4-8 words), then medium (12-18), then long (20-25), then short again
- Start sentences differently: a name, a place, "I", "The", a time, an action, a question
- Use occasional fragments for emphasis
- Throw in a rhetorical question every few paragraphs
- One or two sentences per chapter should be blunt opinions: "Skip it." or "This is overrated."

TRAVEL-SPECIFIC CONTENT RULES:
- Include at least one "I got this wrong" or "fair warning" moment per section
- Mention a specific person by first name (a shopkeeper, a guide, a fellow traveler)
- Include at least one specific price, time, or distance
- Reference a smell, sound, or texture in every section
- Mention something that was closed, broken, or disappointing — real places aren't perfect
- Give alternatives: "If X is closed/full, try Y instead"
- Compare to something familiar: "Think of it as the [familiar thing] but with [twist]"

EXAMPLE of voice (match style, NOT content):
"""
The morning market opens at five, but get there at four-thirty. That extra half hour is when the fishermen are still unloading, and you can watch Aunt Noi — everyone calls her that — sorting shrimp with hands that move faster than you can track. She'll wave you over if you look interested enough. Don't be shy.

I made the mistake of going at seven my first time. Tourist prices. Picked-over produce. A completely different experience. Now I set an alarm, curse it, and go anyway.
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

STRUCTURE:
- Write 23-25 paragraphs covering all sections and subsections
- NO bullet points, NO numbered lists — everything in flowing prose
- Open each section with a real-world scenario or hands-on moment
- Weave technical information into practical narrative — don't lecture

SENTENCE RHYTHM:
- Alternate: short sentence (4-8 words), then medium (12-18), then long (20-25), then short again
- Start sentences differently: a time of day, a season, "I", "The", an animal name, a tool, a question
- Use occasional fragments for emphasis
- Throw in a rhetorical question every few paragraphs
- One or two blunt opinions per chapter: "Don't bother." or "This saved my whole operation."

FARMING-SPECIFIC CONTENT RULES:
- Include at least one mistake or failure per section — what went wrong, what it cost, what you learned
- Use specific numbers: pounds, bushels, dollars, head count, days, temperatures
- Mention specific breeds, varieties, or tool brands by name
- Include seasonal timing: "Plant by mid-April" not "plant in spring"
- Reference weather and its real impact on the work
- Give cost breakdowns when relevant: "Figure $3.50 per chick, $15 in feed per bird to finish weight"
- Mention the physical reality: sore backs, early mornings, mud, heat, cold
- Compare methods honestly: "Method A costs more but saves 10 hours a week"

EXAMPLE of voice (match style, NOT content):
"""
I tried no-till for the first time on a quarter acre of clay soil. The books made it sound easy — just lay down cardboard, pile on compost, and plant through it. What nobody mentioned was that the voles would move in under the cardboard within two weeks and eat every sweet potato start I'd planted. Forty plants. Gone.

Second year I used landscape fabric instead. Not as pretty, not as "sustainable." But I actually got a harvest. Sometimes practical beats ideological.

Your soil tells you what it wants if you pay attention. Grab a handful after a rain. If it forms a tight ball that holds its shape, you've got clay. If it falls apart immediately, that's sand. Most of us are somewhere in between, which is actually fine.
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

STRUCTURE:
- 15-18 paragraphs total
- Open with a specific memory or moment from the journey, not a summary statement
- Practical takeaways CAN use short bullet points (this is the one place lists are okay)
- End with emergency contacts in a clear list format
- Close with a single short paragraph — something the reader will remember

TRAVEL CONCLUSION SPECIFICS:
- Reference a specific place or person from earlier in the book
- Include practical last-minute reminders (what to pack, what to download, what to photocopy)
- Emergency contacts section with real phone numbers format
- A "things I wish I'd known" mini-list
- Final paragraph should make the reader want to book a flight

WHAT TO AVOID:
- Don't open with "In conclusion" or "As we come to the end"
- Don't repeat the chapter titles from earlier in the book
- Don't use "whether you're a beginner or experienced traveler"

SENTENCE RHYTHM:
- Same rules: vary length, vary sentence starters, use occasional fragments
- The final paragraph should be 2-3 sentences maximum. End clean.

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

STRUCTURE:
- 15-18 paragraphs total
- Open with a specific seasonal moment or end-of-day scene on the farm, not a summary statement
- Practical takeaways CAN use short bullet points (this is the one place lists are okay)
- Close with a single short paragraph — something the reader will remember

FARMING CONCLUSION SPECIFICS:
- Reference a specific technique or lesson from earlier in the book
- Include a "first year timeline" or "start here" priority list
- Seasonal planning reminders
- Cost reality check: realistic startup costs and when to expect returns
- A "mistakes everyone makes" mini-list with solutions
- Resource list: where to buy supplies, useful websites, local extension offices

WHAT TO AVOID:
- Don't open with "In conclusion" or "As we come to the end"
- Don't say "farming is a rewarding journey" or any variation of that
- Don't use "sustainable" as a buzzword — if you mention sustainability, be specific about what and how

SENTENCE RHYTHM:
- Same rules: vary length, vary sentence starters, use occasional fragments
- The final paragraph should be 2-3 sentences maximum. End honest.

Write the complete Conclusion chapter now:`;
  }

  // ═══════════════════════════════════════════════════════════════
  // ABOUT BOOK — Domain-aware
  // ═══════════════════════════════════════════════════════════════
  async generateAboutBook(title: string): Promise<string> {
    const contentType = this.detectContentType(title);

    const prompt =
      contentType === 'travel'
        ? `Write an "About This Book" blurb for a travel guide titled "${title}".

4-6 short paragraphs. NO generic phrases like "comprehensive guide" or "everything you need to know."

Instead, be specific about:
- The angle this guide takes (what it covers that other travel books skip)
- Who will get the most out of it (solo backpackers? families? first-timers? repeat visitors?)
- One honest limitation ("This book won't..." or "If you're looking for luxury resort reviews, that's not this")
- How it's organized for actual trip planning, not armchair reading

Tone: confident, direct, slightly informal. Like a back-cover blurb written by the author, not a marketer.`
        : `Write an "About This Book" blurb for a farming guide titled "${title}".

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
