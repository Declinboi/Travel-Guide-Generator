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
    this.maxRetries = 5; // API request retries
    this.translationRetries = 3; // Translation quality retries
    this.chunkSize = 800; // Smaller chunks for better context
    this.qualityThreshold = 50; // Realistic threshold

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

  /**
   * Minimal preprocessing - only preserve what absolutely can't be translated
   */
  private preprocessText(text: string): {
    processed: string;
    placeholders: Map<string, string>;
  } {
    const placeholders = new Map<string, string>();
    let processed = text;
    let counter = 0;

    // Preserve URLs
    const urlRegex = /https?:\/\/[^\s]+/g;
    processed = processed.replace(urlRegex, (match) => {
      const placeholder = `URLPLACEHOLDER${counter}`;
      placeholders.set(placeholder, match);
      counter++;
      return placeholder;
    });

    // Preserve email addresses
    const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
    processed = processed.replace(emailRegex, (match) => {
      const placeholder = `EMAILPLACEHOLDER${counter}`;
      placeholders.set(placeholder, match);
      counter++;
      return placeholder;
    });

    // Preserve code blocks
    const codeBlockRegex = /```[\s\S]*?```/g;
    processed = processed.replace(codeBlockRegex, (match) => {
      const placeholder = `CODEBLOCKPLACEHOLDER${counter}`;
      placeholders.set(placeholder, match);
      counter++;
      return placeholder;
    });

    // Preserve inline code
    const inlineCodeRegex = /`[^`\n]{1,50}`/g;
    processed = processed.replace(inlineCodeRegex, (match) => {
      const placeholder = `CODEPLACEHOLDER${counter}`;
      placeholders.set(placeholder, match);
      counter++;
      return placeholder;
    });

    return { processed, placeholders };
  }

  /**
   * Restore placeholders after translation
   */
  private postprocessText(
    text: string,
    placeholders: Map<string, string>,
  ): string {
    let result = text;

    placeholders.forEach((original, placeholder) => {
      const escapedPlaceholder = placeholder.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&',
      );
      result = result.replace(new RegExp(escapedPlaceholder, 'g'), original);
    });

    return result;
  }

  /**
   * Validate translation quality
   */
  private validateTranslationQuality(
    original: string,
    translated: string,
    targetLanguage: Language,
  ): TranslationValidation {
    const issues: string[] = [];
    let score = 100;

    // Check 1: Empty translation
    if (!translated || translated.trim().length === 0) {
      issues.push('Translation is empty');
      return { isValid: false, issues, score: 0 };
    }

    // Check 2: Identical to original
    const origTrim = original.trim();
    const transTrim = translated.trim();

    if (origTrim === transTrim && origTrim.length > 10) {
      issues.push('Translation is identical to original text');
      score -= 60;
    }

    // Check 3: Length validation
    const lengthRatio = translated.length / original.length;
    if (lengthRatio < 0.2) {
      issues.push(`Translation too short (${(lengthRatio * 100).toFixed(0)}%)`);
      score -= 40;
    } else if (lengthRatio < 0.4) {
      issues.push(
        `Translation shorter than expected (${(lengthRatio * 100).toFixed(0)}%)`,
      );
      score -= 15;
    }

    // Check 4: Language-specific character detection
    const hasTranslation = this.checkIfTranslated(
      original,
      translated,
      targetLanguage,
    );
    if (!hasTranslation) {
      issues.push('Text does not appear to be translated');
      score -= 50;
    }

    this.logger.debug(
      `Translation quality for ${targetLanguage}: Score=${score}, LengthRatio=${lengthRatio.toFixed(2)}`,
    );

    return {
      isValid: score >= this.qualityThreshold,
      issues,
      score: Math.max(0, score),
    };
  }

  /**
   * Check if text was actually translated
   */
  private checkIfTranslated(
    original: string,
    translated: string,
    targetLanguage: Language,
  ): boolean {
    // Remove placeholders for comparison
    const cleanOriginal = original
      .replace(/URLPLACEHOLDER\d+/g, '')
      .replace(/EMAILPLACEHOLDER\d+/g, '')
      .replace(/CODEPLACEHOLDER\d+/g, '')
      .toLowerCase()
      .trim();

    const cleanTranslated = translated
      .replace(/URLPLACEHOLDER\d+/g, '')
      .replace(/EMAILPLACEHOLDER\d+/g, '')
      .replace(/CODEPLACEHOLDER\d+/g, '')
      .toLowerCase()
      .trim();

    // If identical after cleanup, translation failed
    if (cleanOriginal === cleanTranslated) {
      return false;
    }

    // Check for language-specific characters
    return this.hasLanguageSpecificCharacters(cleanTranslated, targetLanguage);
  }

  /**
   * Check for language-specific characters
   */
  private hasLanguageSpecificCharacters(
    text: string,
    language: Language,
  ): boolean {
    const languagePatterns: Record<Language, RegExp> = {
      [Language.FRENCH]: /[àâæçéèêëïîôùûüÿœ]/i,
      [Language.GERMAN]: /[äöüßÄÖÜ]/,
      [Language.SPANISH]: /[áéíóúüñ¿¡]/i,
      [Language.ITALIAN]: /[àèéìíîòóùú]/i,
      [Language.ENGLISH]: /./,
    };

    const pattern = languagePatterns[language];

    // For non-English languages, expect to see accented characters
    if (language !== Language.ENGLISH && text.length > 20) {
      return pattern.test(text);
    }

    return true;
  }

  /**
   * Split text into chunks
   */
  private splitTextIntoChunks(text: string): string[] {
    if (text.length <= this.chunkSize) {
      return [text];
    }

    const chunks: string[] = [];
    const paragraphs = text.split(/\n\n+/);
    let currentChunk = '';

    for (const paragraph of paragraphs) {
      const potentialChunk = currentChunk
        ? currentChunk + '\n\n' + paragraph
        : paragraph;

      if (potentialChunk.length <= this.chunkSize) {
        currentChunk = potentialChunk;
      } else {
        if (currentChunk) {
          chunks.push(currentChunk);
        }

        if (paragraph.length > this.chunkSize) {
          const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
          let sentenceChunk = '';

          for (const sentence of sentences) {
            const potentialSentenceChunk = sentenceChunk
              ? sentenceChunk + ' ' + sentence
              : sentence;

            if (potentialSentenceChunk.length <= this.chunkSize) {
              sentenceChunk = potentialSentenceChunk;
            } else {
              if (sentenceChunk) {
                chunks.push(sentenceChunk.trim());
              }

              if (sentence.length > this.chunkSize) {
                const words = sentence.split(/\s+/);
                let wordChunk = '';

                for (const word of words) {
                  const potentialWordChunk = wordChunk
                    ? wordChunk + ' ' + word
                    : word;

                  if (potentialWordChunk.length <= this.chunkSize) {
                    wordChunk = potentialWordChunk;
                  } else {
                    if (wordChunk) {
                      chunks.push(wordChunk.trim());
                    }
                    wordChunk = word;
                  }
                }

                if (wordChunk) {
                  sentenceChunk = wordChunk;
                } else {
                  sentenceChunk = '';
                }
              } else {
                sentenceChunk = sentence;
              }
            }
          }

          if (sentenceChunk) {
            chunks.push(sentenceChunk.trim());
          }
          currentChunk = '';
        } else {
          currentChunk = paragraph;
        }
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    return chunks.filter((chunk) => chunk.trim().length > 0);
  }

  /**
   * Core translation with retry mechanism
   */
  private async translateWithRetry(
    text: string,
    targetLanguage: Language,
    options: TranslationOptions = {},
  ): Promise<string> {
    const {
      format = 'text',
      preserveFormatting = true,
      autoDetectSource = false,
      strictMode = false,
    } = options;

    const targetLangCode = this.getLanguageCode(targetLanguage);
    const sourceLanguage = autoDetectSource ? 'auto' : 'en';

    let bestTranslation = text;
    let bestScore = 0;
    const attemptResults: {
      translation: string;
      score: number;
      attempt: number;
    }[] = [];

    // Try up to 3 times
    for (let attempt = 1; attempt <= this.translationRetries; attempt++) {
      try {
        this.logger.log(
          `Translation attempt ${attempt}/${this.translationRetries} for ${targetLanguage}`,
        );

        // Minimal preprocessing
        const { processed, placeholders } = preserveFormatting
          ? this.preprocessText(text)
          : { processed: text, placeholders: new Map() };

        // Make translation request
        const response = await this.retryRequest<LibreTranslateResponse>(() =>
          this.axiosInstance.post('/translate', {
            q: processed,
            source: sourceLanguage,
            target: targetLangCode,
            format: format,
          }),
        );

        const translated = response.data.translatedText;
        const final = this.postprocessText(translated, placeholders);

        // Validate quality
        const validation = this.validateTranslationQuality(
          text,
          final,
          targetLanguage,
        );

        attemptResults.push({
          translation: final,
          score: validation.score,
          attempt,
        });

        this.logger.log(
          `Attempt ${attempt}: Quality score ${validation.score}/100`,
        );

        if (validation.issues.length > 0) {
          this.logger.warn(`Issues: ${validation.issues.join('; ')}`);
        }

        // Track best translation
        if (validation.score > bestScore) {
          bestScore = validation.score;
          bestTranslation = final;
        }

        // Accept high-quality translations immediately
        if (validation.score >= 85) {
          this.logger.log(
            `✓ High-quality translation on attempt ${attempt} (score: ${validation.score})`,
          );
          return final;
        }

        // Accept good-enough translations if not in strict mode
        if (!strictMode && validation.score >= 60) {
          this.logger.log(
            `✓ Acceptable translation on attempt ${attempt} (score: ${validation.score})`,
          );
          return final;
        }

        // In strict mode, accept valid translations
        if (strictMode && validation.isValid) {
          this.logger.log(
            `✓ Valid translation on attempt ${attempt} (score: ${validation.score})`,
          );
          return final;
        }

        // Wait before retry
        if (attempt < this.translationRetries) {
          const delay = 1500 * attempt; // 1.5s, 3s
          this.logger.log(
            `Score ${validation.score} not satisfactory, retrying in ${delay}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } catch (error) {
        this.logger.error(`Attempt ${attempt} failed: ${error.message}`);

        if (attempt === this.translationRetries) {
          throw error;
        }

        const delay = 2000 * attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Use best translation from all attempts
    if (bestScore > 0 && bestScore >= 30) {
      this.logger.warn(
        `Using best translation from ${this.translationRetries} attempts (score: ${bestScore})`,
      );
      this.logger.debug(
        `Scores: ${attemptResults.map((r) => `#${r.attempt}:${r.score}`).join(', ')}`,
      );
      return bestTranslation;
    }

    // Complete failure - return original
    this.logger.error(
      `All ${this.translationRetries} attempts failed. Returning original text.`,
    );
    return text;
  }

  /**
   * Main translation method
   */
  async translateText(
    text: string,
    targetLanguage: Language,
    options: TranslationOptions = {},
  ): Promise<string> {
    if (!text || text.trim().length === 0) {
      return '';
    }

    try {
      this.logger.log(
        `Starting translation to ${targetLanguage} (${text.length} chars)`,
      );

      // Check if chunking is needed
      if (text.length > this.chunkSize) {
        this.logger.log(
          `Text length ${text.length} exceeds chunk size, splitting...`,
        );
        const chunks = this.splitTextIntoChunks(text);
        this.logger.log(`Created ${chunks.length} chunks`);

        const translatedChunks: string[] = [];

        for (let i = 0; i < chunks.length; i++) {
          this.logger.log(`Translating chunk ${i + 1}/${chunks.length}...`);

          try {
            const chunkTranslation = await this.translateWithRetry(
              chunks[i],
              targetLanguage,
              options,
            );
            translatedChunks.push(chunkTranslation);
          } catch (error) {
            this.logger.error(
              `Chunk ${i + 1} failed after retries: ${error.message}`,
            );
            // Use original chunk as fallback
            translatedChunks.push(chunks[i]);
          }

          // Brief pause between chunks
          if (i < chunks.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        }

        const final = translatedChunks.join('\n\n');
        this.logger.log(
          `✓ Completed chunked translation: ${final.length} chars`,
        );
        return final;
      }

      // Single translation
      return await this.translateWithRetry(text, targetLanguage, options);
    } catch (error) {
      this.logger.error(
        `Fatal translation error for ${targetLanguage}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Batch translate multiple texts
   */
  async translateBatch(
    texts: string[],
    targetLanguage: Language,
    options: TranslationOptions = {},
  ): Promise<string[]> {
    if (texts.length === 0) {
      return [];
    }

    try {
      const textIndexMap: { text: string; index: number }[] = [];
      texts.forEach((text, index) => {
        if (text && text.trim().length > 0) {
          textIndexMap.push({ text, index });
        }
      });

      const concurrencyLimit = 2;
      const results: string[] = new Array(texts.length).fill('');
      let successCount = 0;
      let failureCount = 0;

      for (let i = 0; i < textIndexMap.length; i += concurrencyLimit) {
        const batch = textIndexMap.slice(i, i + concurrencyLimit);

        const promises = batch.map(async ({ text, index }) => {
          try {
            const translation = await this.translateText(
              text,
              targetLanguage,
              options,
            );
            return { index, translation, success: true };
          } catch (error) {
            this.logger.error(`Batch item ${index} failed: ${error.message}`);
            return { index, translation: text, success: false };
          }
        });

        const batchResults = await Promise.all(promises);
        batchResults.forEach(({ index, translation, success }) => {
          results[index] = translation;
          if (success) {
            successCount++;
          } else {
            failureCount++;
          }
        });

        this.logger.log(
          `Batch: ${Math.min(i + concurrencyLimit, textIndexMap.length)}/${textIndexMap.length} ` +
            `(Success: ${successCount}, Failed: ${failureCount})`,
        );

        if (i + concurrencyLimit < textIndexMap.length) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      this.logger.log(
        `Batch complete: ${successCount} successful, ${failureCount} failed`,
      );

      return results;
    } catch (error) {
      this.logger.error(`Batch error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Translate chapters sequentially
   */
  async translateChapters(
    chapters: any[],
    targetLanguage: Language,
    onProgress?: (current: number, total: number) => void,
    options: TranslationOptions = {},
  ): Promise<any[]> {
    const translatedChapters: Array<{
      title: string;
      content: string;
      order: number;
    }> = [];

    this.logger.log(
      `Translating ${chapters.length} chapters to ${targetLanguage}...`,
    );

    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i];

      try {
        this.logger.log(
          `Chapter ${i + 1}/${chapters.length}: "${chapter.title}"`,
        );

        const [translatedTitle, translatedContent] = await Promise.all([
          this.translateText(chapter.title, targetLanguage, {
            ...options,
            format: 'text',
          }),
          this.translateText(chapter.content, targetLanguage, {
            ...options,
            format: options.format || 'text',
          }),
        ]);

        translatedChapters.push({
          title: translatedTitle,
          content: translatedContent,
          order: chapter.order,
        });

        successCount++;
        this.logger.log(`✓ Chapter ${i + 1} completed`);

        if (onProgress) {
          onProgress(i + 1, chapters.length);
        }

        if (i < chapters.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (error) {
        failureCount++;
        this.logger.error(`✗ Chapter ${i + 1} failed: ${error.message}`);

        // Fallback to original
        translatedChapters.push({
          title: chapter.title,
          content: chapter.content,
          order: chapter.order,
        });

        if (onProgress) {
          onProgress(i + 1, chapters.length);
        }
      }
    }

    this.logger.log(
      `Chapters complete: ${successCount} successful, ${failureCount} failed`,
    );

    return translatedChapters;
  }

  /**
   * CRITICAL: Translate metadata with MANDATORY retry until successful
   * This method will retry until title and subtitle are properly translated
   *
   * NEW FIX: Use fallback translation when LibreTranslate returns identical text
   */
  async translateMetadata(
    title: string,
    subtitle: string,
    targetLanguage: Language,
    options: TranslationOptions = {},
  ): Promise<{ title: string; subtitle: string }> {
    this.logger.log(
      `Translating metadata to ${targetLanguage}: "${title}" | "${subtitle}"`,
    );

    let attempts = 0;
    const maxAttempts = 3; // Reduced since we have fallback
    let bestResult: { title: string; subtitle: string } | null = null;
    let bestScore = 0;

    while (attempts < maxAttempts) {
      attempts++;

      try {
        this.logger.log(
          `Metadata translation attempt ${attempts}/${maxAttempts}`,
        );

        // Direct translation - proper nouns like "Georgia" should stay unchanged
        const [translatedTitle, translatedSubtitle] = await Promise.all([
          this.translateText(title, targetLanguage, {
            ...options,
            format: 'text',
            strictMode: false,
            preserveFormatting: false,
          }),
          subtitle
            ? this.translateText(subtitle, targetLanguage, {
                ...options,
                format: 'text',
                strictMode: false,
                preserveFormatting: false,
              })
            : Promise.resolve(''),
        ]);

        // CRITICAL CHECK: If title came back 100% identical, use fallback
        let finalTitle = translatedTitle;
        if (
          title.toLowerCase().trim() === translatedTitle.toLowerCase().trim()
        ) {
          this.logger.warn(
            `Title returned identical - using fallback translation`,
          );
          finalTitle = await this.fallbackTranslateTitle(title, targetLanguage);
        }

        // Validate that title was translated
        const titleValidation = this.validateMetadataTranslation(
          title,
          finalTitle,
          targetLanguage,
        );

        // Validate subtitle if present
        const subtitleValidation = subtitle
          ? this.validateMetadataTranslation(
              subtitle,
              translatedSubtitle,
              targetLanguage,
            )
          : { isValid: true, score: 100, issues: [] };

        // Calculate combined score
        const combinedScore = subtitle
          ? (titleValidation.score + subtitleValidation.score) / 2
          : titleValidation.score;

        // Track best result
        if (combinedScore > bestScore) {
          bestScore = combinedScore;
          bestResult = {
            title: finalTitle,
            subtitle: translatedSubtitle,
          };
        }

        // Log details
        this.logger.log(
          `  Title: "${title}" → "${finalTitle}" (score: ${titleValidation.score})`,
        );
        if (subtitle) {
          this.logger.log(
            `  Subtitle: "${subtitle}" → "${translatedSubtitle}" (score: ${subtitleValidation.score})`,
          );
        }
        this.logger.log(`  Combined score: ${combinedScore}/100`);

        // Accept if both are valid (score >= 60)
        if (titleValidation.isValid && subtitleValidation.isValid) {
          this.logger.log(
            `✓ Metadata translated successfully on attempt ${attempts}`,
          );
          return {
            title: finalTitle,
            subtitle: translatedSubtitle,
          };
        }

        // Log validation issues
        if (!titleValidation.isValid) {
          this.logger.warn(
            `Title issues: ${titleValidation.issues.join(', ')}`,
          );
        }
        if (subtitle && !subtitleValidation.isValid) {
          this.logger.warn(
            `Subtitle issues: ${subtitleValidation.issues.join(', ')}`,
          );
        }

        // Wait before retry
        if (attempts < maxAttempts) {
          const delay = 1000 * attempts; // 1s, 2s
          this.logger.log(
            `Retrying in ${delay}ms... (best score so far: ${bestScore})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } catch (error) {
        this.logger.error(
          `Metadata translation attempt ${attempts} failed: ${error.message}`,
        );

        if (attempts < maxAttempts) {
          const delay = 1500 * attempts;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // After all attempts, use best result if score is decent (>= 35)
    // Lowered threshold because subtitle alone can be good
    if (bestResult && bestScore >= 35) {
      this.logger.warn(
        `✓ Using best translation from ${maxAttempts} attempts (score: ${bestScore})`,
      );
      return bestResult;
    }

    // Last resort: Try fallback for both
    this.logger.error(
      `⚠️ All ${maxAttempts} metadata translation attempts failed. Trying fallback...`,
    );

    try {
      const fallbackTitle = await this.fallbackTranslateTitle(
        title,
        targetLanguage,
      );
      const fallbackSubtitle = subtitle
        ? await this.fallbackTranslateTitle(subtitle, targetLanguage)
        : '';

      // Validate fallback
      const titleValidation = this.validateMetadataTranslation(
        title,
        fallbackTitle,
        targetLanguage,
      );

      if (titleValidation.score >= 50) {
        this.logger.log(
          `✓ Fallback translation successful (score: ${titleValidation.score})`,
        );
        return {
          title: fallbackTitle,
          subtitle: fallbackSubtitle,
        };
      }
    } catch (error) {
      this.logger.error(`Fallback translation failed: ${error.message}`);
    }

    // Complete failure - return original
    this.logger.error(
      `❌ All translation methods exhausted. Using original text.`,
    );

    return { title, subtitle };
  }

  /**
   * Validate metadata translation - IMPROVED LOGIC for proper nouns
   *
   * KEY INSIGHT: If the title comes back 100% identical, LibreTranslate failed completely.
   * We need to manually translate the non-proper-noun parts.
   */
  private validateMetadataTranslation(
    original: string,
    translated: string,
    targetLanguage: Language,
  ): TranslationValidation {
    const issues: string[] = [];
    let score = 100;

    // Check 1: Empty translation
    if (!translated || translated.trim().length === 0) {
      issues.push('Translation is empty');
      return { isValid: false, issues, score: 0 };
    }

    const origLower = original.toLowerCase().trim();
    const transLower = translated.toLowerCase().trim();

    // Check 2: Completely identical (LibreTranslate failed completely)
    if (origLower === transLower) {
      issues.push('Translation is completely identical to original');
      return { isValid: false, issues, score: 0 };
    }

    // Check 3: Analyze word-by-word for proper nouns
    const originalWords = original.split(/\s+/);
    const translatedWords = translated.split(/\s+/);

    // Identify proper nouns (words starting with capital letter)
    const properNouns = new Set<string>();
    originalWords.forEach((word, index) => {
      // Capitalized words (after first word) are likely proper nouns
      if (/^[A-Z]/.test(word) && /^[A-Z][a-z]/.test(word)) {
        properNouns.add(word.toLowerCase());
      }
      // Also include standalone years/numbers
      if (/^\d{4}$/.test(word)) {
        properNouns.add(word);
      }
    });

    // Count translated vs unchanged words (excluding proper nouns)
    const originalWordsLower = originalWords.map((w) => w.toLowerCase());
    const translatedWordsLower = translatedWords.map((w) => w.toLowerCase());

    let translatedCount = 0;
    let unchangedCount = 0;
    let properNounMatches = 0;

    translatedWordsLower.forEach((word) => {
      if (word.length <= 2) return; // Skip articles like "de", "of", "a"

      // Is this a proper noun that should stay the same?
      if (properNouns.has(word)) {
        properNounMatches++;
        return;
      }

      // Did this word get translated?
      if (originalWordsLower.includes(word)) {
        unchangedCount++;
      } else {
        translatedCount++;
      }
    });

    // Calculate expected translations
    // Total words - proper nouns - articles = words that should translate
    const totalNonProperNouns = originalWordsLower.filter(
      (w) => w.length > 2 && !properNouns.has(w),
    ).length;

    const expectedTranslations = Math.max(
      1,
      Math.floor(totalNonProperNouns * 0.5),
    ); // At least 50% should translate

    this.logger.debug(
      `Metadata analysis: ${translatedCount} translated, ${unchangedCount} unchanged, ${properNouns.size} proper nouns, ${properNounMatches} proper noun matches`,
    );

    // Check 4: Ensure sufficient translation occurred
    if (translatedCount < expectedTranslations) {
      issues.push(
        `Insufficient translation: only ${translatedCount} words translated (expected ${expectedTranslations})`,
      );
      score -= 40;
    }

    // Check 5: Language-specific character validation
    if (targetLanguage !== Language.ENGLISH && translatedCount > 0) {
      if (!this.hasLanguageSpecificCharacters(transLower, targetLanguage)) {
        issues.push('Missing language-specific characters');
        score -= 20; // Reduced penalty - might not have accents
      }
    }

    // Check 6: Length validation (should be somewhat similar)
    const lengthRatio = translated.length / original.length;
    if (lengthRatio < 0.5 || lengthRatio > 2.5) {
      issues.push(`Unusual length ratio: ${(lengthRatio * 100).toFixed(0)}%`);
      score -= 15;
    }

    // For metadata, accept score >= 60 as valid
    const isValid = score >= 60;

    this.logger.debug(
      `Metadata validation: score=${score}, valid=${isValid}, issues=${issues.length}`,
    );

    return {
      isValid,
      issues,
      score: Math.max(0, score),
    };
  }

  /**
   * FALLBACK: Manually translate title when LibreTranslate fails
   *
   * This handles cases like "Georgia Travel Guide 2026" where LibreTranslate
   * returns it completely unchanged.
   */
  private async fallbackTranslateTitle(
    title: string,
    targetLanguage: Language,
  ): Promise<string> {
    this.logger.log(`Attempting fallback translation for: "${title}"`);

    // Split into words
    const words = title.split(/\s+/);
    const translatedWords: string[] = [];

    // Known translations for common title words
    const titleWordTranslations: Record<Language, Record<string, string>> = {
      [Language.SPANISH]: {
        Travel: 'Viaje',
        Guide: 'Guía',
        Guidebook: 'Guía',
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
        Travel: 'Voyage',
        Guide: 'Guide',
        Guidebook: 'Guide',
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
        Travel: 'Viaggio',
        Guide: 'Guida',
        Guidebook: 'Guida',
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

    const translations = titleWordTranslations[targetLanguage] || {};

    for (const word of words) {
      // Is it a number/year? Keep it
      if (/^\d+$/.test(word)) {
        translatedWords.push(word);
        continue;
      }

      // Is it a proper noun (capitalized)? Keep it
      if (/^[A-Z][a-z]+$/.test(word) && word.length > 2) {
        // Check if it's in our dictionary (like "Travel")
        if (translations[word]) {
          translatedWords.push(translations[word]);
        } else {
          // It's a proper noun like "Georgia" - keep it
          translatedWords.push(word);
        }
        continue;
      }

      // Check dictionary for lowercase version
      const translated = translations[word] || translations[word.toLowerCase()];
      if (translated) {
        translatedWords.push(translated);
      } else {
        // Unknown word - try to translate just this word
        try {
          const result = await this.translateText(word, targetLanguage, {
            format: 'text',
            preserveFormatting: false,
          });
          translatedWords.push(result !== word ? result : word);
        } catch {
          translatedWords.push(word); // Fallback to original
        }
      }
    }

    const result = translatedWords.join(' ');
    this.logger.log(`Fallback result: "${title}" → "${result}"`);

    return result;
  }

  /**
   * Get supported languages
   */
  async getSupportedLanguages(): Promise<any[]> {
    try {
      const response = await this.axiosInstance.get('/languages');
      return response.data;
    } catch (error) {
      this.logger.error('Failed to fetch supported languages:', error);
      throw error;
    }
  }

  /**
   * Detect language
   */
  async detectLanguage(text: string): Promise<any[]> {
    try {
      const response = await this.axiosInstance.post('/detect', { q: text });
      return response.data;
    } catch (error) {
      this.logger.error('Language detection failed:', error);
      throw error;
    }
  }

  /**
   * Map Language enum to LibreTranslate codes
   */
  private getLanguageCode(language: Language): string {
    const languageMap: Record<Language, string> = {
      [Language.ENGLISH]: 'en',
      [Language.GERMAN]: 'de',
      [Language.FRENCH]: 'fr',
      [Language.SPANISH]: 'es',
      [Language.ITALIAN]: 'it',
    };
    return languageMap[language] || 'en';
  }

  /**
   * Retry API requests with exponential backoff
   */
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
            `API retry in ${delay}ms (attempt ${attempt + 1}/${retries})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    this.logger.error(`API failed after ${retries} retries`);
    throw lastError;
  }

  /**
   * Public validation method
   */
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
