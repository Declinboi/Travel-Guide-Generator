// src/translation/libre-translation.service.ts
import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Language } from 'src/DB/entities';
import axios, { AxiosInstance } from 'axios';

interface LibreTranslateResponse {
  translatedText: string;
}

interface TranslationOptions {
  format?: 'text' | 'html';
  preserveFormatting?: boolean;
  autoDetectSource?: boolean;
  strictMode?: boolean;
}

interface TranslationValidation {
  isValid: boolean;
  issues: string[];
  score: number;
}

interface SourceLanguageProtection {
  processed: string;
  placeholders: Map<string, string>;
}

interface CompoundSubstitutionResult {
  // Text with compound animal tokens fully removed; remaining text is
  // clean English that LibreTranslate can handle without any placeholders.
  stripped: string;
  // Ordered list of { position marker, target-language word } pairs so
  // we can re-insert them into the translated output.
  extractions: Array<{ marker: string; targetWord: string }>;
}

@Injectable()
export class LibreTranslationService {
  private readonly logger = new Logger(LibreTranslationService.name);
  private readonly axiosInstance: AxiosInstance;
  private readonly apiUrl: string;
  private readonly apiKey: string | null;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly translationRetries: number;
  private readonly chunkSize: number;
  private readonly qualityThreshold: number;

  constructor(private configService: ConfigService) {
    this.apiUrl =
      this.configService.get<string>('LIBRETRANSLATE_API_URL') ||
      'http://localhost:5000';
    this.apiKey =
      this.configService.get<string>('LIBRETRANSLATE_API_KEY') || null;
    this.timeout =
      this.configService.get<number>('LIBRETRANSLATE_TIMEOUT') || 120000;
    this.maxRetries = 5;
    this.translationRetries = 3;
    this.chunkSize = 800;
    this.qualityThreshold = 50;

    this.axiosInstance = axios.create({
      baseURL: this.apiUrl,
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.axiosInstance.interceptors.request.use((config) => {
      if (this.apiKey) {
        config.params = { ...config.params, api_key: this.apiKey };
      }
      return config;
    });

    this.axiosInstance.interceptors.response.use(
      (response) => response,
      (error) => {
        this.logger.error('LibreTranslate API error:', error.message);
        if (error.response) {
          throw new HttpException(
            error.response.data?.error || 'Translation service error',
            error.response.status,
          );
        }
        throw new HttpException(
          'Translation service unavailable',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      },
    );

    this.logger.log(`LibreTranslate service initialized at ${this.apiUrl}`);
    this.checkHealth();
  }

  private async checkHealth(): Promise<void> {
    try {
      await this.axiosInstance.get('/health');
      this.logger.log('LibreTranslate service is healthy');
    } catch (error) {
      this.logger.warn('LibreTranslate health check failed:', error.message);
    }
  }

  // ---------------------------------------------------------------------------
  // PREPROCESSING — protect technical tokens that must never be translated.
  // ---------------------------------------------------------------------------

  private preprocessText(text: string): {
    processed: string;
    placeholders: Map<string, string>;
  } {
    const placeholders = new Map<string, string>();
    let processed = text;
    let counter = 0;

    const urlRegex = /https?:\/\/[^\s]+/g;
    processed = processed.replace(urlRegex, (match) => {
      const key = `URLPLACEHOLDER${counter++}`;
      placeholders.set(key, match);
      return key;
    });

    const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
    processed = processed.replace(emailRegex, (match) => {
      const key = `EMAILPLACEHOLDER${counter++}`;
      placeholders.set(key, match);
      return key;
    });

    const codeBlockRegex = /```[\s\S]*?```/g;
    processed = processed.replace(codeBlockRegex, (match) => {
      const key = `CODEBLOCKPLACEHOLDER${counter++}`;
      placeholders.set(key, match);
      return key;
    });

    const inlineCodeRegex = /`[^`\n]{1,50}`/g;
    processed = processed.replace(inlineCodeRegex, (match) => {
      const key = `CODEPLACEHOLDER${counter++}`;
      placeholders.set(key, match);
      return key;
    });

    return { processed, placeholders };
  }

  private postprocessText(
    text: string,
    placeholders: Map<string, string>,
  ): string {
    let result = text;
    placeholders.forEach((original, key) => {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escaped, 'gi'), original);

      const neutralNonEnglishMatch = key.match(/^ZXQNE(\d+)QXZ$/i);
      if (neutralNonEnglishMatch) {
        const index = neutralNonEnglishMatch[1];
        result = result.replace(
          new RegExp(String.raw`\bZXQNE\s*${index}\s*QXZ\b`, 'gi'),
          original,
        );
      }

      const oldNonEnglishMatch = key.match(/^NONENGLISHSOURCE(\d+)$/i);
      if (oldNonEnglishMatch) {
        const index = oldNonEnglishMatch[1];
        const variants = [
          String.raw`\bNON\s*ENGLISH\s*SOURCE\s*${index}\b`,
          String.raw`\bNONGLISH\s*SOURCE\s*${index}\b`,
          String.raw`\bSOURCE\s*NON\s*ENGLISH\s*${index}\b`,
          String.raw`\bSOURCE\s*NONGLISH\s*${index}\b`,
          String.raw`\bENGLISH\s*SOURCE\s*${index}\b`,
        ];

        for (const variant of variants) {
          result = result.replace(new RegExp(variant, 'gi'), original);
        }
      }
    });

    result = this.removeLeakedTranslationPlaceholders(result);
    return result;
  }

  private removeLeakedTranslationPlaceholders(text: string): string {
    return text
      .replace(/\bNON\s*ENGLISH\s*SOURCE\s*\d+\b/gi, '')
      .replace(/\bNONGLISH\s*SOURCE\s*\d+\b/gi, '')
      .replace(/\bSOURCE\s*NON\s*ENGLISH\s*\d+\b/gi, '')
      .replace(/\bSOURCE\s*NONGLISH\s*\d+\b/gi, '')
      .replace(/\bZXQNE\s*\d+\s*QXZ\b/gi, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .trim();
  }

  // ---------------------------------------------------------------------------
  // COMPOUND ANIMAL NAME SUBSTITUTION
  //
  // The core problem: tokens like "Grasscutter(Cane Rat)" break LibreTranslate's
  // tokeniser across all language pairs. Every placeholder strategy we tried
  // (ALL-CAPS tokens, notranslate spans, numeric keys) fails for at least one
  // language — Italian drops ALL-CAPS tokens silently, German translates "CANRAT"
  // as "ANWENDUNGSBEREICH", and LibreTranslate mangles span tags in French/Spanish
  // leaving raw `__0__` or `_0____` in the output.
  //
  // THE CORRECT APPROACH — extract-translate-reattach:
  //  1. EXTRACT: Remove the compound token entirely from the input. Send only
  //     the clean English remainder (e.g. "farming Guide") to LibreTranslate.
  //  2. TRANSLATE: LibreTranslate translates the clean English without any
  //     problematic tokens, producing a clean target-language output.
  //  3. REATTACH: Prepend the known target-language animal name (e.g. "Rohrratte")
  //     to the translated remainder.
  //
  // The animal name is ALREADY KNOWN before translation — it is in the
  // COMPOUND_ANIMAL_RULES table. There is no need to send it through the engine.
  // ---------------------------------------------------------------------------

  private readonly COMPOUND_ANIMAL_RULES: Record<
    Language,
    Array<{ pattern: RegExp; replacement: string }>
  > = {
    [Language.SPANISH]: [
      {
        pattern: /Grasscutters?\s*\(Cane\s*Rats?\)/gi,
        replacement: 'Rata de caña',
      },
    ],
    [Language.FRENCH]: [
      {
        pattern: /Grasscutters?\s*\(Cane\s*Rats?\)/gi,
        replacement: 'Rat des cannes',
      },
    ],
    [Language.GERMAN]: [
      {
        pattern: /Grasscutters?\s*\(Cane\s*Rats?\)/gi,
        replacement: 'Rohrratte',
      },
    ],
    [Language.ITALIAN]: [
      {
        pattern: /Grasscutters?\s*\(Cane\s*Rats?\)/gi,
        replacement: 'Ratto della canna',
      },
    ],
    [Language.ENGLISH]: [],
  };

  /**
   * Extract compound animal tokens from `text`, returning:
   *  - `stripped`: the text with those tokens removed (clean English for LibreTranslate)
   *  - `extractions`: the target-language words to reattach after translation
   *
   * Called before sending to LibreTranslate. After translation, call
   * reattachCompoundAnimals() to prepend the extracted words.
   */
  private extractCompoundAnimals(
    text: string,
    targetLanguage: Language,
  ): CompoundSubstitutionResult {
    const rules = this.COMPOUND_ANIMAL_RULES[targetLanguage] ?? [];
    let stripped = text;
    const extractions: Array<{ marker: string; targetWord: string }> = [];

    for (const { pattern, replacement } of rules) {
      pattern.lastIndex = 0;
      stripped = stripped.replace(pattern, (match) => {
        this.logger.log(
          `Extracting compound animal: "${match}" → will reattach as "${replacement}"`,
        );
        extractions.push({ marker: match, targetWord: replacement });
        return ''; // remove from text entirely
      });
    }

    // Collapse any double-spaces left by the removal
    stripped = stripped.replace(/\s{2,}/g, ' ').trim();

    return { stripped, extractions };
  }

  /**
   * After translation, prepend the extracted target-language animal names.
   * We prepend because the animal name was at the start of the original title.
   * For body content the animal names are reattached at the front of the
   * translated chunk — acceptable since the surrounding sentence is translated.
   */
  private reattachCompoundAnimals(
    translated: string,
    extractions: Array<{ marker: string; targetWord: string }>,
  ): string {
    if (extractions.length === 0) return translated;
    const animalWords = extractions.map((e) => e.targetWord).join(' ');
    const result = `${animalWords} ${translated}`.trim();
    this.logger.log(
      `Reattached compound animals: "${translated}" → "${result}"`,
    );
    return result;
  }

  // ---------------------------------------------------------------------------
  // NON-ENGLISH SOURCE PROTECTION (body content only, never metadata)
  // ---------------------------------------------------------------------------

  private async detectLanguageCode(
    text: string,
  ): Promise<{ language: string; confidence: number } | null> {
    const clean = text
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '')
      .trim();

    if (clean.length < 10) return null;

    try {
      const detected = await this.detectLanguage(clean.slice(0, 500));
      const best = Array.isArray(detected) ? detected[0] : null;
      if (!best?.language) return null;
      return {
        language: String(best.language).toLowerCase(),
        confidence: Number(best.confidence ?? best.score ?? 0),
      };
    } catch {
      return null;
    }
  }

  private async isDefinitelyNonEnglish(text: string): Promise<boolean> {
    const trimmed = text.trim();
    if (trimmed.length < 8 || /^\W+$/.test(trimmed)) return false;

    const hasDiacritics = /[À-ÖØ-öø-ÿ¿¡]/.test(trimmed);
    const englishFunctionWords =
      /\b(the|and|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|shall|should|may|might|must|can|could|this|that|these|those|with|for|from|into|onto|upon|about|above|below|after|before|during|through|between|among|because|although|however|therefore|moreover|furthermore|nevertheless|consequently)\b/i;

    if (englishFunctionWords.test(trimmed)) return false;

    const detected = await this.detectLanguageCode(trimmed);
    if (!detected) return false;
    if (detected.language === 'en') return false;

    if (hasDiacritics && detected.confidence >= 0.8) return true;
    if (!hasDiacritics && detected.confidence >= 0.9) return true;

    return false;
  }

  private async protectNonEnglishSpans(
    text: string,
  ): Promise<SourceLanguageProtection> {
    const placeholders = new Map<string, string>();
    let counter = 0;

    const protect = (value: string): string => {
      const key = `ZXQNE${counter++}QXZ`;
      placeholders.set(key, value);
      return key;
    };

    const paragraphs = text.split(/(\n{2,})/);
    for (let i = 0; i < paragraphs.length; i++) {
      const part = paragraphs[i];
      if (!part || /^\n+$/.test(part) || part.includes('ZXQNE'))
        continue;
      if (await this.isDefinitelyNonEnglish(part)) {
        this.logger.debug(
          `Protecting non-English paragraph (${part.length} chars)`,
        );
        paragraphs[i] = protect(part);
      }
    }
    let processed = paragraphs.join('');

    const sentenceRegex = /([^.!?\n]+[.!?]+)/g;
    const parts = processed.split(sentenceRegex);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part || part.includes('ZXQNE')) continue;
      const wordCount = part.trim().split(/\s+/).filter(Boolean).length;
      if (wordCount < 5) continue;
      if (await this.isDefinitelyNonEnglish(part)) {
        this.logger.debug(
          `Protecting non-English sentence: "${part.slice(0, 60)}..."`,
        );
        parts[i] = protect(part);
      }
    }
    processed = parts.join('');

    if (placeholders.size > 0) {
      this.logger.log(
        `Protected ${placeholders.size} non-English span(s) from translation`,
      );
    }

    return { processed, placeholders };
  }

  // ---------------------------------------------------------------------------
  // TRANSLATION QUALITY VALIDATION
  // ---------------------------------------------------------------------------

  private readonly ENGLISH_CONTENT_WORDS = new Set([
    'about',
    'after',
    'against',
    'also',
    'among',
    'and',
    'around',
    'because',
    'before',
    'between',
    'book',
    'bring',
    'carry',
    'chapter',
    'check',
    'choose',
    'cost',
    'costs',
    'cover',
    'covers',
    'daily',
    'during',
    'each',
    'early',
    'evening',
    'every',
    'farming',
    'field',
    'fields',
    'find',
    'follow',
    'food',
    'fresh',
    'from',
    'getting',
    'give',
    'good',
    'great',
    'grow',
    'guide',
    'have',
    'help',
    'here',
    'high',
    'hour',
    'hours',
    'important',
    'include',
    'into',
    'keep',
    'know',
    'large',
    'late',
    'learn',
    'local',
    'long',
    'look',
    'make',
    'many',
    'market',
    'meal',
    'meals',
    'morning',
    'most',
    'much',
    'need',
    'night',
    'only',
    'open',
    'other',
    'people',
    'pick',
    'place',
    'places',
    'plan',
    'price',
    'prices',
    'provide',
    'readers',
    'ready',
    'section',
    'should',
    'small',
    'some',
    'start',
    'stay',
    'take',
    'than',
    'that',
    'their',
    'there',
    'these',
    'they',
    'this',
    'ticket',
    'time',
    'tips',
    'today',
    'together',
    'travel',
    'under',
    'until',
    'using',
    'visit',
    'water',
    'when',
    'where',
    'which',
    'while',
    'with',
    'without',
    'worth',
    'would',
    'your',
  ]);

  private validateTranslationQuality(
    original: string,
    translated: string,
    targetLanguage: Language,
  ): TranslationValidation {
    const issues: string[] = [];
    let score = 100;

    if (!translated || translated.trim().length === 0) {
      return { isValid: false, issues: ['Translation is empty'], score: 0 };
    }

    const stripPlaceholders = (t: string) =>
      this.removeLeakedTranslationPlaceholders(
        t.replace(
          /\b(URL|EMAIL|CODE(?:BLOCK)?|NONENGLISHSOURCE|ZXQNE)PLACEHOLDER?\d+(?:QXZ)?\b/gi,
          '',
        ),
      ).trim();

    const origClean = stripPlaceholders(original).toLowerCase();
    const transClean = stripPlaceholders(translated).toLowerCase();

    if (origClean === transClean && origClean.length > 10) {
      issues.push('Translation is identical to original');
      score -= 60;
    }

    const lengthRatio = translated.length / Math.max(original.length, 1);
    if (lengthRatio < 0.2) {
      issues.push(`Translation too short (${(lengthRatio * 100).toFixed(0)}%)`);
      score -= 40;
    } else if (lengthRatio < 0.4) {
      issues.push(
        `Translation shorter than expected (${(lengthRatio * 100).toFixed(0)}%)`,
      );
      score -= 15;
    }

    if (targetLanguage !== Language.ENGLISH) {
      if (!this.hasTargetLanguageMarkers(transClean, targetLanguage)) {
        issues.push('Missing target-language markers');
        score -= 30;
      }
    }

    if (targetLanguage !== Language.ENGLISH) {
      const remaining = this.countRemainingEnglishWords(original, translated);
      if (remaining.count >= 10) {
        issues.push(
          `Many English words remain untranslated (${remaining.count}): ${remaining.sample.join(', ')}`,
        );
        score -= 40;
      } else if (remaining.count >= 5) {
        issues.push(
          `Some English words remain untranslated (${remaining.count}): ${remaining.sample.join(', ')}`,
        );
        score -= 20;
      } else if (remaining.count >= 2) {
        score -= 8;
      }
    }

    this.logger.debug(
      `Quality [${targetLanguage}]: score=${score}, ratio=${lengthRatio.toFixed(2)}`,
    );

    return {
      isValid: score >= this.qualityThreshold,
      issues,
      score: Math.max(0, score),
    };
  }

  private countRemainingEnglishWords(
    original: string,
    translated: string,
  ): { count: number; sample: string[] } {
    const stripPlaceholders = (t: string) =>
      this.removeLeakedTranslationPlaceholders(
        t.replace(
          /\b(URL|EMAIL|CODE(?:BLOCK)?|NONENGLISHSOURCE|ZXQNE)PLACEHOLDER?\d+(?:QXZ)?\b/gi,
          '',
        ),
      );

    const origWords = new Set(
      stripPlaceholders(original)
        .toLowerCase()
        .match(/\b[a-z]{4,}\b/g) || [],
    );
    const transTokens = new Set(
      stripPlaceholders(translated)
        .toLowerCase()
        .match(/\b[a-z]{4,}\b/g) || [],
    );
    const properNouns = new Set(
      (original.match(/\b[A-Z][a-z]{2,}\b/g) || []).map((w) => w.toLowerCase()),
    );

    const remaining: string[] = [];
    for (const word of origWords) {
      if (properNouns.has(word)) continue;
      if (!this.ENGLISH_CONTENT_WORDS.has(word)) continue;
      if (transTokens.has(word)) remaining.push(word);
    }

    return { count: remaining.length, sample: remaining.slice(0, 12) };
  }

  private hasTargetLanguageMarkers(text: string, language: Language): boolean {
    if (language === Language.ENGLISH) return true;

    const patterns: Record<Language, RegExp[]> = {
      [Language.FRENCH]: [
        /[àâæçéèêëïîôùûüÿœ]/i,
        /\b(le|la|les|des|du|un|une|et|avec|pour|dans|sur|vous|nous|est|sont|pas|plus|très|ce|cette|ces|qui|que|au|aux)\b/i,
      ],
      [Language.GERMAN]: [
        /[äöüßÄÖÜ]/,
        /\b(der|die|das|den|dem|ein|eine|und|oder|mit|für|auf|ist|sind|nicht|auch|sie|ihre|wenn|zum|zur|von|bei|nach)\b/i,
      ],
      [Language.SPANISH]: [
        /[áéíóúüñ¿¡]/i,
        /\b(el|la|los|las|un|una|unos|unas|y|con|para|por|en|de|que|es|son|no|más|esta|este|como|lo|se|del)\b/i,
      ],
      [Language.ITALIAN]: [
        /[àèéìíîòóùú]/i,
        /\b(il|lo|la|gli|le|un|una|uno|e|con|per|di|che|è|sono|non|più|questo|questa|come|nel|nella|del|della)\b/i,
      ],
      [Language.ENGLISH]: [/./],
    };

    return (patterns[language] ?? []).some((p) => p.test(text));
  }

  // ---------------------------------------------------------------------------
  // CHUNKING
  // ---------------------------------------------------------------------------

  private splitTextIntoChunks(text: string): string[] {
    if (text.length <= this.chunkSize) return [text];

    const chunks: string[] = [];
    const paragraphs = text.split(/\n\n+/);
    let currentChunk = '';

    for (const paragraph of paragraphs) {
      const candidate = currentChunk
        ? `${currentChunk}\n\n${paragraph}`
        : paragraph;

      if (candidate.length <= this.chunkSize) {
        currentChunk = candidate;
      } else {
        if (currentChunk) chunks.push(currentChunk);

        if (paragraph.length > this.chunkSize) {
          const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
          let sentenceChunk = '';

          for (const sentence of sentences) {
            const sc = sentenceChunk
              ? `${sentenceChunk} ${sentence}`
              : sentence;
            if (sc.length <= this.chunkSize) {
              sentenceChunk = sc;
            } else {
              if (sentenceChunk) chunks.push(sentenceChunk.trim());
              if (sentence.length > this.chunkSize) {
                const words = sentence.split(/\s+/);
                let wordChunk = '';
                for (const word of words) {
                  const wc = wordChunk ? `${wordChunk} ${word}` : word;
                  if (wc.length <= this.chunkSize) {
                    wordChunk = wc;
                  } else {
                    if (wordChunk) chunks.push(wordChunk.trim());
                    wordChunk = word;
                  }
                }
                sentenceChunk = wordChunk;
              } else {
                sentenceChunk = sentence;
              }
            }
          }
          if (sentenceChunk) chunks.push(sentenceChunk.trim());
          currentChunk = '';
        } else {
          currentChunk = paragraph;
        }
      }
    }

    if (currentChunk) chunks.push(currentChunk);
    return chunks.filter((c) => c.trim().length > 0);
  }

  // ---------------------------------------------------------------------------
  // CORE TRANSLATION (body content)
  //
  // Pipeline per attempt:
  //  1. Extract compound animal tokens from the text entirely
  //  2. Protect non-English spans in the stripped text
  //  3. Protect technical tokens (URLs, emails, code)
  //  4. POST clean English to LibreTranslate
  //  5. Restore tech + non-English placeholders
  //  6. Reattach the pre-known target-language animal words at the front
  //  7. Validate quality; retry if needed
  // ---------------------------------------------------------------------------

  private async translateWithRetry(
    text: string,
    targetLanguage: Language,
    options: TranslationOptions = {},
  ): Promise<string> {
    const { format = 'text', preserveFormatting = true } = options;
    const targetLangCode = this.getLanguageCode(targetLanguage);
    const SOURCE_LANG = 'en';

    let bestTranslation = text;
    let bestScore = 0;
    const attemptLog: string[] = [];

    for (let attempt = 1; attempt <= this.translationRetries; attempt++) {
      try {
        this.logger.log(
          `Translation attempt ${attempt}/${this.translationRetries} → ${targetLanguage}`,
        );

        // Step 1: extract compound animal tokens — send clean English to LibreTranslate
        const { stripped, extractions } = this.extractCompoundAnimals(
          text,
          targetLanguage,
        );

        // Step 2: protect non-English spans in the stripped text
        const nonEnglishProtection =
          await this.protectNonEnglishSpans(stripped);

        // Step 3: protect technical tokens
        const { processed, placeholders } = preserveFormatting
          ? this.preprocessText(nonEnglishProtection.processed)
          : {
              processed: nonEnglishProtection.processed,
              placeholders: new Map<string, string>(),
            };

        // Step 4: translate clean English
        const response = await this.retryRequest<LibreTranslateResponse>(() =>
          this.axiosInstance.post('/translate', {
            q: processed,
            source: SOURCE_LANG,
            target: targetLangCode,
            format,
          }),
        );

        const rawTranslated = response.data.translatedText;

        // Step 5: restore placeholders
        const restoredTech = this.postprocessText(rawTranslated, placeholders);
        const restoredNonEn = this.postprocessText(
          restoredTech,
          nonEnglishProtection.placeholders,
        );

        // Step 6: reattach pre-known target-language animal names
        const final = this.reattachCompoundAnimals(restoredNonEn, extractions);

        // Step 7: validate
        const validation = this.validateTranslationQuality(
          text,
          final,
          targetLanguage,
        );
        attemptLog.push(`#${attempt}:${validation.score}`);

        this.logger.log(
          `Attempt ${attempt}: score=${validation.score}/100 ${
            validation.issues.length
              ? '| Issues: ' + validation.issues.join('; ')
              : ''
          }`,
        );

        if (validation.score > bestScore) {
          bestScore = validation.score;
          bestTranslation = final;
        }

        if (validation.score >= 85) {
          this.logger.log(`✓ High-quality translation on attempt ${attempt}`);
          return final;
        }

        if (validation.score >= 60) {
          this.logger.log(`✓ Acceptable translation on attempt ${attempt}`);
          return final;
        }

        if (attempt < this.translationRetries) {
          const delay = 1500 * attempt;
          this.logger.warn(
            `Score ${validation.score} insufficient, retrying in ${delay}ms…`,
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      } catch (error) {
        this.logger.error(`Attempt ${attempt} failed: ${error.message}`);
        if (attempt === this.translationRetries) throw error;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }

    this.logger.debug(`Attempt scores: ${attemptLog.join(', ')}`);

    if (bestScore >= 30) {
      this.logger.warn(`Using best translation (score: ${bestScore})`);
      return bestTranslation;
    }

    this.logger.error('All translation attempts failed — returning original.');
    return text;
  }

  // ---------------------------------------------------------------------------
  // PUBLIC API
  // ---------------------------------------------------------------------------

  async translateText(
    text: string,
    targetLanguage: Language,
    options: TranslationOptions = {},
  ): Promise<string> {
    if (!text || text.trim().length === 0) return '';

    try {
      this.logger.log(
        `Starting translation → ${targetLanguage} (${text.length} chars)`,
      );

      if (text.length > this.chunkSize) {
        this.logger.log('Text exceeds chunk size — splitting…');
        const chunks = this.splitTextIntoChunks(text);
        this.logger.log(`Created ${chunks.length} chunk(s)`);

        const translatedChunks: string[] = [];

        for (let i = 0; i < chunks.length; i++) {
          this.logger.log(`Chunk ${i + 1}/${chunks.length}…`);
          try {
            const result = await this.translateWithRetry(
              chunks[i],
              targetLanguage,
              options,
            );
            translatedChunks.push(result);
          } catch (err) {
            this.logger.error(
              `Chunk ${i + 1} failed: ${err.message} — using original`,
            );
            translatedChunks.push(chunks[i]);
          }

          if (i < chunks.length - 1) {
            await new Promise((r) => setTimeout(r, 300));
          }
        }

        const final = translatedChunks.join('\n\n');
        this.logger.log(
          `✓ Chunked translation complete: ${final.length} chars`,
        );
        return final;
      }

      return await this.translateWithRetry(text, targetLanguage, options);
    } catch (error) {
      this.logger.error(
        `Fatal translation error [${targetLanguage}]: ${error.message}`,
      );
      throw error;
    }
  }

  async translateTOCContent(
    content: string,
    targetLanguage: Language,
  ): Promise<string> {
    const lines = content.split('\n');
    const translatedLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        translatedLines.push(line); // preserve blank lines
        continue;
      }
      try {
        const translated = await this.translateText(trimmed, targetLanguage, {
          format: 'text',
        });
        // Preserve original leading whitespace (for indentation)
        const leadingSpace = line.match(/^(\s*)/)?.[1] ?? '';
        translatedLines.push(leadingSpace + translated);
      } catch {
        translatedLines.push(line); // fallback to original
      }
      // Small delay to avoid hammering LibreTranslate
      await new Promise((r) => setTimeout(r, 100));
    }

    return translatedLines.join('\n');
  }

  // Add this to LibreTranslationService
  private isTableOfContentsChapter(title: string): boolean {
    const tocKeywords = [
      'table of contents',
      'inhaltsverzeichnis',
      'table des matières',
      'sommaire',
      'tabella dei contenuti',
      'índice',
      'tabla de contenidos',
      'cuadro de contenidos',
    ];
    const lowerTitle = title.toLowerCase();
    return tocKeywords.some((keyword) => lowerTitle.includes(keyword));
  }

  async translateBatch(
    texts: string[],
    targetLanguage: Language,
    options: TranslationOptions = {},
  ): Promise<string[]> {
    if (texts.length === 0) return [];

    const indexed = texts
      .map((text, index) => ({ text, index }))
      .filter(({ text }) => text && text.trim().length > 0);

    const CONCURRENCY = 2;
    const results: string[] = new Array(texts.length).fill('');
    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < indexed.length; i += CONCURRENCY) {
      const batch = indexed.slice(i, i + CONCURRENCY);

      const settled = await Promise.all(
        batch.map(async ({ text, index }) => {
          try {
            const translation = await this.translateText(
              text,
              targetLanguage,
              options,
            );
            return { index, translation, ok: true };
          } catch (err) {
            this.logger.error(`Batch item ${index} failed: ${err.message}`);
            return { index, translation: text, ok: false };
          }
        }),
      );

      settled.forEach(({ index, translation, ok }) => {
        results[index] = translation;
        ok ? successCount++ : failureCount++;
      });

      this.logger.log(
        `Batch progress: ${Math.min(i + CONCURRENCY, indexed.length)}/${indexed.length} ` +
          `(✓${successCount} ✗${failureCount})`,
      );

      if (i + CONCURRENCY < indexed.length) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    this.logger.log(`Batch done: ${successCount} OK, ${failureCount} failed`);
    return results;
  }

  // In LibreTranslationService — add this method
  private async translateChapterContent(
    content: string,
    targetLanguage: Language,
    options: TranslationOptions = {},
  ): Promise<string> {
    // Split by double newline to preserve paragraph/subheading boundaries
    const paragraphs = content.split(/\n\n/);
    const translatedParagraphs: string[] = [];

    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i];
      const trimmed = para.trim();

      if (!trimmed) {
        translatedParagraphs.push('');
        continue;
      }

      try {
        // If paragraph is short and has no period → likely a subheading
        // Translate it individually to prevent merging with surrounding text
        const isLikelySubheading =
          trimmed.split(' ').length <= 12 &&
          !/\.\s+[A-Za-z]/.test(trimmed) &&
          !/[.!]$/.test(trimmed);

        if (isLikelySubheading || trimmed.length <= this.chunkSize) {
          const translated = await this.translateWithRetry(
            trimmed,
            targetLanguage,
            options,
          );
          translatedParagraphs.push(translated);
        } else {
          const translated = await this.translateText(
            trimmed,
            targetLanguage,
            options,
          );
          translatedParagraphs.push(translated);
        }
      } catch {
        translatedParagraphs.push(para); // fallback to original
      }

      if (i < paragraphs.length - 1) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    return translatedParagraphs.join('\n\n');
  }

  async translateChapters(
    chapters: any[],
    targetLanguage: Language,
    onProgress?: (current: number, total: number) => void,
    options: TranslationOptions = {},
  ): Promise<any[]> {
    this.logger.log(
      `Translating ${chapters.length} chapters → ${targetLanguage}…`,
    );

    const translatedChapters: Array<{
      title: string;
      content: string;
      order: number;
    }> = [];
    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i];
      try {
        this.logger.log(
          `Chapter ${i + 1}/${chapters.length}: "${chapter.title}"`,
        );

        const [translatedTitle, translatedContent] = await Promise.all([
          this.translateText(chapter.title, targetLanguage, { format: 'text' }),
          this.isTableOfContentsChapter(chapter.title)
            ? this.translateTOCContent(chapter.content, targetLanguage)
            : this.translateChapterContent(
                chapter.content,
                targetLanguage,
                options,
              ),
        ]);

        translatedChapters.push({
          title: translatedTitle,
          content: translatedContent,
          order: chapter.order,
        });
        successCount++;
        this.logger.log(`✓ Chapter ${i + 1} done`);
      } catch (err) {
        failureCount++;
        this.logger.error(`✗ Chapter ${i + 1} failed: ${err.message}`);
        translatedChapters.push({
          title: chapter.title,
          content: chapter.content,
          order: chapter.order,
        });
      }

      onProgress?.(i + 1, chapters.length);

      if (i < chapters.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    this.logger.log(`Chapters: ${successCount} ✓, ${failureCount} ✗`);
    return translatedChapters;
  }

  // ---------------------------------------------------------------------------
  // METADATA TRANSLATION
  // ---------------------------------------------------------------------------

  async translateMetadata(
    title: string,
    subtitle: string,
    targetLanguage: Language,
    options: TranslationOptions = {},
  ): Promise<{ title: string; subtitle: string }> {
    this.logger.log(
      `Translating metadata → ${targetLanguage}: "${title}" | "${subtitle}"`,
    );

    let attempts = 0;
    const maxAttempts = 3;
    let bestResult: { title: string; subtitle: string } | null = null;
    let bestScore = 0;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        this.logger.log(`Metadata attempt ${attempts}/${maxAttempts}`);

        const [translatedTitle, translatedSubtitle] = await Promise.all([
          this.translateMetadataField(title, targetLanguage, options),
          subtitle
            ? this.translateMetadataField(subtitle, targetLanguage, options)
            : Promise.resolve(''),
        ]);

        let finalTitle = translatedTitle;
        const { percentage, unchangedWords } = this.getTranslationPercentage(
          title,
          translatedTitle,
        );

        this.logger.log(
          `Title translation: ${percentage.toFixed(0)}% translated (unchanged: ${unchangedWords.join(', ') || 'none'})`,
        );

        if (percentage < 80) {
          this.logger.warn(
            `Title below 80% translated — applying fallback merge`,
          );
          finalTitle = this.mergeWithFallback(
            title,
            translatedTitle,
            targetLanguage,
          );
        }

        finalTitle = this.injectMissingAnimalTranslations(
          title,
          finalTitle,
          targetLanguage,
        );

        const titleVal = this.validateMetadataTranslation(
          title,
          finalTitle,
          targetLanguage,
        );
        const subtitleVal = subtitle
          ? this.validateMetadataTranslation(
              subtitle,
              translatedSubtitle,
              targetLanguage,
            )
          : { isValid: true, score: 100, issues: [] as string[] };

        const combined = subtitle
          ? (titleVal.score + subtitleVal.score) / 2
          : titleVal.score;

        this.logger.log(
          `  Title: "${title}" → "${finalTitle}" (score: ${titleVal.score})`,
        );
        if (subtitle) {
          this.logger.log(
            `  Subtitle: "${subtitle}" → "${translatedSubtitle}" (score: ${subtitleVal.score})`,
          );
        }
        this.logger.log(`  Combined: ${combined}/100`);

        if (combined > bestScore) {
          bestScore = combined;
          bestResult = { title: finalTitle, subtitle: translatedSubtitle };
        }

        if (titleVal.isValid && subtitleVal.isValid) {
          this.logger.log(`✓ Metadata translated on attempt ${attempts}`);
          return { title: finalTitle, subtitle: translatedSubtitle };
        }

        if (!titleVal.isValid)
          this.logger.warn(`Title issues: ${titleVal.issues.join(', ')}`);
        if (subtitle && !subtitleVal.isValid)
          this.logger.warn(`Subtitle issues: ${subtitleVal.issues.join(', ')}`);

        if (attempts < maxAttempts) {
          const delay = 1000 * attempts;
          this.logger.log(`Retrying in ${delay}ms (best: ${bestScore})…`);
          await new Promise((r) => setTimeout(r, delay));
        }
      } catch (err) {
        this.logger.error(
          `Metadata attempt ${attempts} failed: ${err.message}`,
        );
        if (attempts < maxAttempts) {
          await new Promise((r) => setTimeout(r, 1500 * attempts));
        }
      }
    }

    if (bestResult && bestScore >= 35) {
      this.logger.warn(`Using best metadata result (score: ${bestScore})`);
      return bestResult;
    }

    this.logger.error(
      'All metadata attempts failed — trying word-by-word fallback…',
    );
    try {
      const fallbackTitle = await this.fallbackTranslateTitle(
        title,
        targetLanguage,
      );
      const fallbackSubtitle = subtitle
        ? await this.fallbackTranslateTitle(subtitle, targetLanguage)
        : '';
      const val = this.validateMetadataTranslation(
        title,
        fallbackTitle,
        targetLanguage,
      );
      if (val.score >= 50) {
        this.logger.log(`✓ Fallback successful (score: ${val.score})`);
        return { title: fallbackTitle, subtitle: fallbackSubtitle };
      }
    } catch (err) {
      this.logger.error(`Fallback failed: ${err.message}`);
    }

    this.logger.error(
      '❌ All translation methods exhausted — returning original.',
    );
    return { title, subtitle };
  }

  /**
   * Translate a single metadata field via LibreTranslate.
   *
   * Pipeline:
   *  1. extractCompoundAnimals — remove tokens like "Grasscutter(Cane Rat)"
   *     entirely from the text. LibreTranslate only sees clean English.
   *  2. POST clean English to /translate with format='text'.
   *  3. reattachCompoundAnimals — prepend the pre-known target-language animal
   *     name (e.g. "Rohrratte") to the translated text.
   *
   * This approach requires no placeholders, no span tags, and no key formats
   * that any language model might mangle or translate. The animal name is
   * looked up from the rules table — never sent through the engine.
   */
  private async translateMetadataField(
    text: string,
    targetLanguage: Language,
    options: TranslationOptions,
  ): Promise<string> {
    const targetLangCode = this.getLanguageCode(targetLanguage);

    // Step 1: remove compound animal tokens — send only clean English
    const { stripped, extractions } = this.extractCompoundAnimals(
      text,
      targetLanguage,
    );

    if (extractions.length > 0) {
      this.logger.log(
        `Compound extractions (metadata): ${extractions
          .map(
            (e) =>
              `"${e.marker}" extracted, will reattach as "${e.targetWord}"`,
          )
          .join(', ')}`,
      );
    }

    // Step 2: translate the clean English remainder
    const textToTranslate = stripped || text; // fallback if stripping leaves nothing
    const response = await this.retryRequest<LibreTranslateResponse>(() =>
      this.axiosInstance.post('/translate', {
        q: textToTranslate,
        source: 'en',
        target: targetLangCode,
        format: options.format ?? 'text',
      }),
    );

    // Step 3: reattach the pre-known target-language animal name
    return this.reattachCompoundAnimals(
      response.data.translatedText,
      extractions,
    );
  }

  // ---------------------------------------------------------------------------
  // METADATA HELPERS
  // ---------------------------------------------------------------------------

  private injectMissingAnimalTranslations(
    original: string,
    translated: string,
    targetLanguage: Language,
  ): string {
    const isFarming = this.isFarmingContext(original);
    if (!isFarming) return translated;

    const animalTranslations: Record<Language, Record<string, string>> = {
      [Language.SPANISH]: {
        Snail: 'Caracol',
        Snails: 'Caracoles',
        Worm: 'Gusano',
        Worms: 'Gusanos',
        Quail: 'Codorniz',
        Frog: 'Rana',
        Frogs: 'Ranas',
        Shrimp: 'Camarón',
        Crab: 'Cangrejo',
        Catfish: 'Bagre',
        Tilapia: 'Tilapia',
        Chicken: 'Pollo',
        Chickens: 'Pollos',
        Cow: 'Vaca',
        Cows: 'Vacas',
        Cattle: 'Ganado',
        Pig: 'Cerdo',
        Pigs: 'Cerdos',
        Sheep: 'Oveja',
        Goat: 'Cabra',
        Goats: 'Cabras',
        Rabbit: 'Conejo',
        Rabbits: 'Conejos',
        Bee: 'Abeja',
        Bees: 'Abejas',
        Fish: 'Pez',
        Duck: 'Pato',
        Ducks: 'Patos',
      },
      [Language.FRENCH]: {
        Snail: 'Escargot',
        Snails: 'Escargots',
        Worm: 'Ver',
        Worms: 'Vers',
        Quail: 'Caille',
        Frog: 'Grenouille',
        Frogs: 'Grenouilles',
        Shrimp: 'Crevette',
        Crab: 'Crabe',
        Catfish: 'Poisson-chat',
        Tilapia: 'Tilapia',
        Chicken: 'Poulet',
        Chickens: 'Poulets',
        Cow: 'Vache',
        Cows: 'Vaches',
        Cattle: 'Bétail',
        Pig: 'Cochon',
        Pigs: 'Cochons',
        Sheep: 'Mouton',
        Goat: 'Chèvre',
        Goats: 'Chèvres',
        Rabbit: 'Lapin',
        Rabbits: 'Lapins',
        Bee: 'Abeille',
        Bees: 'Abeilles',
        Fish: 'Poisson',
        Duck: 'Canard',
        Ducks: 'Canards',
      },
      [Language.GERMAN]: {
        Snail: 'Schnecke',
        Snails: 'Schnecken',
        Worm: 'Wurm',
        Worms: 'Würmer',
        Quail: 'Wachtel',
        Frog: 'Frosch',
        Frogs: 'Frösche',
        Shrimp: 'Garnele',
        Crab: 'Krabbe',
        Catfish: 'Wels',
        Tilapia: 'Tilapia',
        Chicken: 'Huhn',
        Chickens: 'Hühner',
        Cow: 'Kuh',
        Cows: 'Kühe',
        Cattle: 'Rinder',
        Pig: 'Schwein',
        Pigs: 'Schweine',
        Sheep: 'Schaf',
        Goat: 'Ziege',
        Goats: 'Ziegen',
        Rabbit: 'Kaninchen',
        Rabbits: 'Kaninchen',
        Bee: 'Biene',
        Bees: 'Bienen',
        Fish: 'Fisch',
        Duck: 'Ente',
        Ducks: 'Enten',
      },
      [Language.ITALIAN]: {
        Snail: 'Lumaca',
        Snails: 'Lumache',
        Worm: 'Verme',
        Worms: 'Vermi',
        Quail: 'Quaglia',
        Frog: 'Rana',
        Frogs: 'Rane',
        Shrimp: 'Gambero',
        Crab: 'Granchio',
        Catfish: 'Pesce gatto',
        Tilapia: 'Tilapia',
        Chicken: 'Pollo',
        Chickens: 'Polli',
        Cow: 'Mucca',
        Cows: 'Mucche',
        Cattle: 'Bestiame',
        Pig: 'Maiale',
        Pigs: 'Maiali',
        Sheep: 'Pecora',
        Goat: 'Capra',
        Goats: 'Capre',
        Rabbit: 'Coniglio',
        Rabbits: 'Conigli',
        Bee: 'Ape',
        Bees: 'Api',
        Fish: 'Pesce',
        Duck: 'Anatra',
        Ducks: 'Anatre',
      },
      [Language.ENGLISH]: {},
    };

    const translations = animalTranslations[targetLanguage] || {};
    let result = translated;
    const injected: string[] = [];

    for (const word of original.split(/\s+/)) {
      const clean = word.replace(/[^a-zA-Z]/g, '');
      if (!clean) continue;
      const key = clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
      const tgt = translations[key] || translations[clean];
      if (!tgt) continue;

      const engPresent = new RegExp(`\\b${clean}\\b`, 'i').test(result);
      const tgtPresent = new RegExp(
        tgt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'i',
      ).test(result);

      if (!engPresent && !tgtPresent) {
        this.logger.warn(
          `Animal "${clean}" dropped by LibreTranslate — injecting "${tgt}"`,
        );
        injected.push(tgt);
      }
    }

    if (injected.length > 0) {
      result = `${injected.join(' ')} ${result}`;
      this.logger.log(`Injected: "${translated}" → "${result}"`);
    }

    return result;
  }

  private getFallbackWord(
    word: string,
    targetLanguage: Language,
  ): string | null {
    const dict: Record<Language, Record<string, string>> = {
      [Language.SPANISH]: {
        travel: 'de Viaje',
        guide: 'Guía',
        guidebook: 'Guía',
        farming: 'de Cría',
        book: 'Libro',
        complete: 'Completa',
        ultimate: 'Definitiva',
        essential: 'Esencial',
        the: 'La',
        a: 'Una',
        to: 'a',
        and: 'y',
        in: 'en',
        for: 'para',
      },
      [Language.FRENCH]: {
        travel: 'de Voyage',
        guide: 'Guide',
        guidebook: 'Guide',
        farming: "l'elevage",
        book: 'Livre',
        complete: 'Complet',
        ultimate: 'Ultime',
        essential: 'Essentiel',
        the: 'Le',
        a: 'Un',
        to: 'à',
        and: 'et',
        in: 'en',
        for: 'pour',
      },
      [Language.GERMAN]: {
        travel: 'Reise',
        guide: 'Führer',
        guidebook: 'Reiseführer',
        farming: 'Landwirtschafts',
        farm: 'Zucht',
        book: 'Buch',
        complete: 'Vollständige',
        ultimate: 'Ultimate',
        essential: 'Wesentliche',
        the: 'Der',
        a: 'Ein',
        to: 'zu',
        and: 'und',
        in: 'in',
        for: 'für',
      },
      [Language.ITALIAN]: {
        travel: 'Turistica',
        guide: 'Guida',
        guidebook: 'Guida',
        farming: "all'allevamento di",
        book: 'Libro',
        complete: 'Completa',
        ultimate: 'Definitiva',
        essential: 'Essenziale',
        the: 'La',
        a: 'Una',
        to: 'a',
        and: 'e',
        in: 'in',
        for: 'per',
      },
      [Language.ENGLISH]: {},
    };
    const map = dict[targetLanguage] || {};
    return map[word.toLowerCase()] || null;
  }

  private mergeWithFallback(
    original: string,
    libreTranslated: string,
    targetLanguage: Language,
  ): string {
    const isFarming = this.isFarmingContext(original);
    const origWords = original.split(/\s+/);

    this.logger.debug(
      `mergeWithFallback: "${original}" | libre="${libreTranslated}" | farming=${isFarming}`,
    );

    const finalWords = libreTranslated.split(/\s+/).map((resultWord) => {
      const clean = resultWord.replace(/[^a-zA-Z]/g, '');
      if (!clean || clean.length <= 2 || /^\d+$/.test(clean)) return resultWord;

      const animal = this.getAnimalTranslation(
        clean,
        targetLanguage,
        isFarming,
      );
      if (animal && animal.toLowerCase() !== clean.toLowerCase())
        return resultWord.replace(clean, animal);

      const fallback = this.getFallbackWord(clean, targetLanguage);
      if (fallback && fallback.toLowerCase() !== clean.toLowerCase())
        return resultWord.replace(clean, fallback);

      const origMatch = origWords.find(
        (w) => w.toLowerCase() === clean.toLowerCase(),
      );
      if (origMatch) {
        const retry = this.getAnimalTranslation(
          origMatch,
          targetLanguage,
          isFarming,
        );
        if (retry && retry.toLowerCase() !== origMatch.toLowerCase())
          return resultWord.replace(clean, retry);
      }

      return resultWord;
    });

    const result = finalWords.join(' ');
    this.logger.log(`mergeWithFallback result: "${result}"`);
    return result;
  }

  private getTranslationPercentage(
    original: string,
    translated: string,
  ): { percentage: number; unchangedWords: string[] } {
    const words = (t: string) =>
      t.split(/\s+/).filter((w) => w.length > 2 && !/^\d+$/.test(w));

    const origWords = words(original);
    const transSet = new Set(words(translated).map((w) => w.toLowerCase()));

    if (origWords.length === 0) return { percentage: 100, unchangedWords: [] };

    const unchanged = origWords.filter((w) => transSet.has(w.toLowerCase()));
    const pct =
      ((origWords.length - unchanged.length) / origWords.length) * 100;
    return { percentage: pct, unchangedWords: unchanged };
  }

  private validateMetadataTranslation(
    original: string,
    translated: string,
    targetLanguage: Language,
  ): TranslationValidation {
    const issues: string[] = [];
    let score = 100;

    if (!translated || translated.trim().length === 0)
      return { isValid: false, issues: ['Empty translation'], score: 0 };

    const origLower = original.toLowerCase().trim();
    const transLower = translated.toLowerCase().trim();

    if (origLower === transLower)
      return { isValid: false, issues: ['Identical to original'], score: 0 };

    const origWords = original.split(/\s+/);
    const transWords = translated.split(/\s+/);

    const properNouns = new Set(
      origWords
        .filter((w) => /^[A-Z][a-z]/.test(w))
        .map((w) => w.toLowerCase()),
    );

    const origLowerWords = origWords.map((w) => w.toLowerCase());
    const transLowerWords = transWords.map((w) => w.toLowerCase());

    let translatedCount = 0;

    for (const w of transLowerWords) {
      if (w.length <= 2) continue;
      if (properNouns.has(w)) continue;
      origLowerWords.includes(w) ? void 0 : translatedCount++;
    }

    const totalNonProper = origLowerWords.filter(
      (w) => w.length > 2 && !properNouns.has(w),
    ).length;
    const expected = Math.max(1, Math.floor(totalNonProper * 0.5));
    if (translatedCount < expected) {
      issues.push(
        `Insufficient translation: ${translatedCount} words translated (expected ≥ ${expected})`,
      );
      score -= 40;
    }

    if (targetLanguage !== Language.ENGLISH && translatedCount > 0) {
      if (!this.hasTargetLanguageMarkers(transLower, targetLanguage)) {
        issues.push('Missing target-language markers');
        score -= 20;
      }
    }

    const lenRatio = translated.length / Math.max(original.length, 1);
    if (lenRatio < 0.5 || lenRatio > 2.5) {
      issues.push(`Unusual length ratio: ${(lenRatio * 100).toFixed(0)}%`);
      score -= 15;
    }

    return { isValid: score >= 60, issues, score: Math.max(0, score) };
  }

  private async fallbackTranslateTitle(
    title: string,
    targetLanguage: Language,
  ): Promise<string> {
    this.logger.log(`Word-by-word fallback for: "${title}"`);
    const isFarming = this.isFarmingContext(title);

    const dict: Record<Language, Record<string, string>> = {
      [Language.SPANISH]: {
        Travel: 'de Viaje',
        Guide: 'Guía',
        Guidebook: 'Guía',
        Farming: 'de Cría',
        Book: 'Libro',
        Complete: 'Completa',
        Ultimate: 'Definitiva',
        Essential: 'Esencial',
        The: 'La',
        A: 'Una',
        to: 'a',
        and: 'y',
        in: 'en',
        for: 'para',
      },
      [Language.FRENCH]: {
        Travel: 'de Voyage',
        Guide: 'Guide',
        Guidebook: 'Guide',
        Farming: "l'elevage",
        Book: 'Livre',
        Complete: 'Complet',
        Ultimate: 'Ultime',
        Essential: 'Essentiel',
        The: 'Le',
        A: 'Un',
        to: 'à',
        and: 'et',
        in: 'en',
        for: 'pour',
      },
      [Language.GERMAN]: {
        Travel: 'Reise',
        Guide: 'Führer',
        Guidebook: 'Reiseführer',
        Farming: 'Landwirtschafts',
        Farm: 'Zucht',
        Book: 'Buch',
        Complete: 'Vollständige',
        Ultimate: 'Ultimate',
        Essential: 'Wesentliche',
        The: 'Der',
        A: 'Ein',
        to: 'zu',
        and: 'und',
        in: 'in',
        for: 'für',
      },
      [Language.ITALIAN]: {
        Travel: 'Turistica',
        Guide: 'Guida',
        Guidebook: 'Guida',
        Farming: "all'allevamento di",
        Book: 'Libro',
        Complete: 'Completa',
        Ultimate: 'Definitiva',
        Essential: 'Essenziale',
        The: 'La',
        A: 'Una',
        to: 'a',
        and: 'e',
        in: 'in',
        for: 'per',
      },
      [Language.ENGLISH]: {},
    };

    const translations = dict[targetLanguage] || {};
    const words = title.split(/\s+/);
    const result: string[] = [];

    for (const word of words) {
      if (/^\d+$/.test(word)) {
        result.push(word);
        continue;
      }

      const animal = this.getAnimalTranslation(word, targetLanguage, isFarming);
      if (animal) {
        result.push(animal);
        continue;
      }

      if (/^[A-Z][a-z]+$/.test(word) && word.length > 2) {
        result.push(translations[word] ?? word);
        continue;
      }

      const fallback = translations[word] || translations[word.toLowerCase()];
      if (fallback) {
        result.push(fallback);
        continue;
      }

      try {
        const r = await this.translateMetadataField(word, targetLanguage, {
          format: 'text',
        });
        result.push(r !== word ? r : word);
      } catch {
        result.push(word);
      }
    }

    const final = result.join(' ');
    this.logger.log(`Fallback: "${title}" → "${final}"`);
    return final;
  }

  private isFarmingContext(title: string): boolean {
    return /\b(farm(?:ing)?|agriculture|agricultural|crop|crops|harvest|livestock|poultry|raising|breeding|husbandry)\b/i.test(
      title,
    );
  }

  private getAnimalTranslation(
    word: string,
    targetLanguage: Language,
    isFarmingContext: boolean,
  ): string | null {
    if (!isFarmingContext) return null;

    const dict: Record<Language, Record<string, string>> = {
      [Language.SPANISH]: {
        Snail: 'Caracol',
        Snails: 'Caracoles',
        Worm: 'Gusano',
        Worms: 'Gusanos',
        Quail: 'Codorniz',
        Frog: 'Rana',
        Frogs: 'Ranas',
        Shrimp: 'Camarón',
        Crab: 'Cangrejo',
        Catfish: 'Bagre',
        Tilapia: 'Tilapia',
        Chicken: 'Pollo',
        Chickens: 'Pollos',
        Cow: 'Vaca',
        Cows: 'Vacas',
        Cattle: 'Ganado',
        Cricket: 'Grillo',
        Pig: 'Cerdo',
        Pigs: 'Cerdos',
        Sheep: 'Oveja',
        Goat: 'Cabra',
        Goats: 'Cabras',
        Horse: 'Caballo',
        Horses: 'Caballos',
        Duck: 'Pato',
        Ducks: 'Patos',
        Turkey: 'Pavo',
        Turkeys: 'Pavos',
        Rabbit: 'Conejo',
        Rabbits: 'Conejos',
        Bee: 'Abeja',
        Bees: 'Abejas',
        Fish: 'Pez',
        Poultry: 'Aves de Corral',
        Livestock: 'Ganado',
        'Grasscutter(Cane Rat)': 'Rata de caña',
        'Grasscutters(Cane Rats)': 'Ratas de caña',
      },
      [Language.FRENCH]: {
        Snail: 'Escargot',
        Snails: 'Escargots',
        Worm: 'Ver',
        Worms: 'Vers',
        Quail: 'Caille',
        Frog: 'Grenouille',
        Frogs: 'Grenouilles',
        Shrimp: 'Crevette',
        Crab: 'Crabe',
        Catfish: 'Poisson-chat',
        Tilapia: 'Tilapia',
        Chicken: 'Poulet',
        Chickens: 'Poulets',
        Cow: 'Vache',
        Cows: 'Vaches',
        Cattle: 'Bétail',
        Cricket: 'Grillon',
        Pig: 'Cochon',
        Pigs: 'Cochons',
        Sheep: 'Mouton',
        Goat: 'Chèvre',
        Goats: 'Chèvres',
        Horse: 'Cheval',
        Horses: 'Chevaux',
        Duck: 'Canard',
        Ducks: 'Canards',
        Turkey: 'Dinde',
        Turkeys: 'Dindes',
        Rabbit: 'Lapin',
        Rabbits: 'Lapins',
        Bee: 'Abeille',
        Bees: 'Abeilles',
        Fish: 'Poisson',
        Poultry: 'Volaille',
        Livestock: 'Bétail',
        'Grasscutter(Cane Rat)': 'Rat des cannes',
        'Grasscutters(Cane Rats)': 'Rats des cannes',
      },
      [Language.GERMAN]: {
        Snail: 'Schnecken',
        Snails: 'Schnecken',
        Worm: 'Wurm',
        Worms: 'Würmer',
        Quail: 'Wachtel',
        Frog: 'Frosch',
        Frogs: 'Frösche',
        Shrimp: 'Garnele',
        Crab: 'Krabbe',
        Catfish: 'Wels',
        Tilapia: 'Tilapia',
        Chicken: 'Huhn',
        Chickens: 'Hühner',
        Cricket: 'Grillenzucht',
        Cow: 'Kuh',
        Cows: 'Kühe',
        Cattle: 'Rinder',
        Pig: 'Schwein',
        Pigs: 'Schweine',
        Sheep: 'Schaf',
        Goat: 'Ziege',
        Goats: 'Ziegen',
        Horse: 'Pferd',
        Horses: 'Pferde',
        Duck: 'Ente',
        Ducks: 'Enten',
        Turkey: 'Truthahn',
        Turkeys: 'Truthähne',
        Rabbit: 'Kaninchen',
        Rabbits: 'Kaninchen',
        Bee: 'Biene',
        Bees: 'Bienen',
        Fish: 'Fisch',
        Poultry: 'Geflügel',
        Livestock: 'Vieh',
        'Grasscutter(Cane Rat)': 'Rohrratte',
        'Grasscutters(Cane Rats)': 'Rohrratten',
      },
      [Language.ITALIAN]: {
        Snail: 'Lumaca',
        Snails: 'Lumache',
        Worm: 'Verme',
        Worms: 'Vermi',
        Quail: 'Quaglia',
        Frog: 'Rana',
        Frogs: 'Rane',
        Shrimp: 'Gambero',
        Crab: 'Granchio',
        Catfish: 'Pesce gatto',
        Tilapia: 'Tilapia',
        Chicken: 'Pollo',
        Chickens: 'Polli',
        Cow: 'Mucca',
        Cows: 'Mucche',
        Cattle: 'Bestiame',
        Cricket: 'Grilli',
        Pig: 'Maiale',
        Pigs: 'Maiali',
        Sheep: 'Pecora',
        Goat: 'Capra',
        Goats: 'Capre',
        Horse: 'Cavallo',
        Horses: 'Cavalli',
        Duck: 'Anatra',
        Ducks: 'Anatre',
        Turkey: 'Tacchino',
        Turkeys: 'Tacchini',
        Rabbit: 'Coniglio',
        Rabbits: 'Conigli',
        Bee: 'Ape',
        Bees: 'Api',
        Fish: 'Pesce',
        Poultry: 'Pollame',
        Livestock: 'Bestiame',
        'Grasscutter(Cane Rat)': 'Ratto della canna',
        'Grasscutters(Cane Rats)': 'Ratti della canna',
      },
      [Language.ENGLISH]: {},
    };

    const map = dict[targetLanguage] || {};
    const key = word
      .split(/\s+/)
      .map((w) => {
        if (!w) return w;
        const m = w.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/);
        if (!m || m.index === undefined) return w.toLowerCase();
        const idx = m.index;
        const prefix = w.slice(0, idx);
        const rest = w.slice(idx);
        return (
          prefix + rest.charAt(0).toUpperCase() + rest.slice(1).toLowerCase()
        );
      })
      .join(' ');
    return map[key] || map[word] || null;
  }

  // ---------------------------------------------------------------------------
  // LANGUAGE UTILITIES
  // ---------------------------------------------------------------------------

  async getSupportedLanguages(): Promise<any[]> {
    try {
      const response = await this.axiosInstance.get('/languages');
      return response.data;
    } catch (error) {
      this.logger.error('Failed to fetch supported languages:', error);
      throw error;
    }
  }

  async detectLanguage(text: string): Promise<any[]> {
    try {
      const response = await this.axiosInstance.post('/detect', { q: text });
      return response.data;
    } catch (error) {
      this.logger.error('Language detection failed:', error);
      throw error;
    }
  }

  private getLanguageCode(language: Language): string {
    const map: Record<Language, string> = {
      [Language.ENGLISH]: 'en',
      [Language.GERMAN]: 'de',
      [Language.FRENCH]: 'fr',
      [Language.SPANISH]: 'es',
      [Language.ITALIAN]: 'it',
    };
    return map[language] ?? 'en';
  }

  private async retryRequest<T>(
    requestFn: () => Promise<{ data: T }>,
    retries: number = this.maxRetries,
  ): Promise<{ data: T }> {
    let lastError: any;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await requestFn();
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
          this.logger.warn(
            `API retry in ${delay}ms (${attempt + 1}/${retries})`,
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    this.logger.error(`API failed after ${retries} retries`);
    throw lastError;
  }

  async validateTranslation(
    original: string,
    translated: string,
    targetLanguage: Language,
  ): Promise<{ isValid: boolean; issues: string[]; score: number }> {
    return this.validateTranslationQuality(
      original,
      translated,
      targetLanguage,
    );
  }
}
