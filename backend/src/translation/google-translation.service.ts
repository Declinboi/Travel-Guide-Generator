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
}

@Injectable()
export class LibreTranslationService {
  private readonly logger = new Logger(LibreTranslationService.name);
  private readonly axiosInstance: AxiosInstance;
  private readonly apiUrl: string;
  private readonly apiKey: string | null;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly chunkSize: number;

  constructor(private configService: ConfigService) {
    this.apiUrl =
      this.configService.get<string>('LIBRETRANSLATE_API_URL') ||
      'http://localhost:5000';
    this.apiKey =
      this.configService.get<string>('LIBRETRANSLATE_API_KEY') || null;
    this.timeout =
      this.configService.get<number>('LIBRETRANSLATE_TIMEOUT') || 120000;
    this.maxRetries = 5;
    this.chunkSize = 3000;

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
   * Preprocess text to preserve special content that shouldn't be translated
   */
  private preprocessText(text: string): {
    processed: string;
    placeholders: Map<string, string>;
  } {
    const placeholders = new Map<string, string>();
    let processed = text;
    let counter = 0;

    // Preserve URLs
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    processed = processed.replace(urlRegex, (match) => {
      const placeholder = `__URL_${counter}__`;
      placeholders.set(placeholder, match);
      counter++;
      return placeholder;
    });

    // Preserve email addresses
    const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/g;
    processed = processed.replace(emailRegex, (match) => {
      const placeholder = `__EMAIL_${counter}__`;
      placeholders.set(placeholder, match);
      counter++;
      return placeholder;
    });

    // Preserve code blocks (markdown style)
    const codeBlockRegex = /```[\s\S]*?```/g;
    processed = processed.replace(codeBlockRegex, (match) => {
      const placeholder = `__CODE_BLOCK_${counter}__`;
      placeholders.set(placeholder, match);
      counter++;
      return placeholder;
    });

    // Preserve inline code
    const inlineCodeRegex = /`([^`]+)`/g;
    processed = processed.replace(inlineCodeRegex, (match) => {
      const placeholder = `__CODE_${counter}__`;
      placeholders.set(placeholder, match);
      counter++;
      return placeholder;
    });

    // Preserve numbers with units (e.g., 100kg, 5.5m, $50)
    const numberUnitRegex =
      /\b\d+\.?\d*\s*(?:kg|g|m|cm|mm|km|lb|oz|ft|in|yd|mi|°C|°F|K|%|\$|€|£|¥)\b/gi;
    processed = processed.replace(numberUnitRegex, (match) => {
      const placeholder = `__UNIT_${counter}__`;
      placeholders.set(placeholder, match);
      counter++;
      return placeholder;
    });

    // Preserve HTML tags
    const htmlTagRegex = /<[^>]+>/g;
    processed = processed.replace(htmlTagRegex, (match) => {
      const placeholder = `__HTML_${counter}__`;
      placeholders.set(placeholder, match);
      counter++;
      return placeholder;
    });

    // Preserve special characters and symbols that might break translation
    const specialSymbolRegex = /[\{\}\[\]<>]/g;
    processed = processed.replace(specialSymbolRegex, (match) => {
      const placeholder = `__SYM_${counter}__`;
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

    // Sort placeholders by key to ensure correct order
    const sortedPlaceholders = Array.from(placeholders.entries()).sort(
      (a, b) => {
        const numA = parseInt(a[0].match(/\d+/)?.[0] || '0');
        const numB = parseInt(b[0].match(/\d+/)?.[0] || '0');
        return numB - numA; // Reverse order to avoid partial replacements
      },
    );

    sortedPlaceholders.forEach(([placeholder, original]) => {
      result = result.replace(new RegExp(placeholder, 'g'), original);
    });

    return result;
  }

  /**
   * Log potentially untranslated English words
   */
  private logUntranslatedWords(
    original: string,
    translated: string,
    language: Language,
  ): void {
    try {
      // Extract English words from original (simple word detection)
      const originalWords = new Set(
        (original.toLowerCase().match(/\b[a-z]{4,}\b/g) || []).filter(
          (word) => !this.isCommonWord(word),
        ),
      );

      // Extract words from translated text
      const translatedLowerCase = translated.toLowerCase();

      // Find English words that appear unchanged in translation
      const untranslated = Array.from(originalWords).filter((word) =>
        translatedLowerCase.includes(word),
      );

      if (untranslated.length > 0) {
        this.logger.warn(
          `Potentially untranslated English words in ${language} (showing first 15): ${untranslated
            .slice(0, 15)
            .join(', ')}`,
        );

        // If more than 20% of significant words are untranslated, warn
        const percentageUntranslated =
          (untranslated.length / originalWords.size) * 100;
        if (percentageUntranslated > 20) {
          this.logger.error(
            `HIGH PERCENTAGE of untranslated words detected: ${percentageUntranslated.toFixed(1)}%`,
          );
        }
      }
    } catch (error) {
      // Don't let logging errors break the translation flow
      this.logger.debug('Error in untranslated word detection:', error);
    }
  }

  /**
   * Check if a word is a common word that might appear in multiple languages
   */
  private isCommonWord(word: string): boolean {
    const commonWords = new Set([
      'the',
      'and',
      'for',
      'are',
      'but',
      'not',
      'you',
      'all',
      'can',
      'her',
      'was',
      'one',
      'our',
      'out',
      'day',
      'get',
      'has',
      'him',
      'his',
      'how',
      'man',
      'new',
      'now',
      'old',
      'see',
      'time',
      'two',
      'way',
      'who',
      'boy',
      'did',
      'its',
      'let',
      'put',
      'say',
      'she',
      'too',
      'use',
      'been',
      'have',
      'into',
      'like',
      'more',
      'some',
      'than',
      'them',
      'then',
      'this',
      'that',
      'what',
      'when',
      'with',
      'your',
      'from',
      'they',
      'will',
      'would',
      'there',
      'their',
      'which',
      'about',
      'after',
      'could',
      'other',
      'these',
      'think',
      'also',
      'back',
      'well',
      'only',
      'come',
      'good',
      'just',
      'know',
      'make',
      'over',
      'such',
      'take',
      'than',
      'very',
      'where',
      'work',
      'year',
      'most',
    ]);
    return commonWords.has(word.toLowerCase());
  }

  /**
   * Split text into chunks for translation
   */
  private splitTextIntoChunks(text: string): string[] {
    if (text.length <= this.chunkSize) {
      return [text];
    }

    const chunks: string[] = [];
    const paragraphs = text.split('\n\n');
    let currentChunk = '';

    for (const paragraph of paragraphs) {
      if ((currentChunk + paragraph).length <= this.chunkSize) {
        currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
      } else {
        if (currentChunk) {
          chunks.push(currentChunk);
        }

        // If single paragraph is too large, split by sentences
        if (paragraph.length > this.chunkSize) {
          const sentences = paragraph.split('. ');
          let sentenceChunk = '';

          for (const sentence of sentences) {
            if ((sentenceChunk + sentence).length <= this.chunkSize) {
              sentenceChunk += (sentenceChunk ? '. ' : '') + sentence;
            } else {
              if (sentenceChunk) {
                chunks.push(sentenceChunk);
              }
              sentenceChunk = sentence;
            }
          }

          if (sentenceChunk) {
            chunks.push(sentenceChunk);
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

    return chunks;
  }

  /**
   * Translate a single text with chunking support and preprocessing
   */
  async translateText(
    text: string,
    targetLanguage: Language,
    options: TranslationOptions = {},
  ): Promise<string> {
    if (!text || text.trim().length === 0) {
      return '';
    }

    const {
      format = 'text',
      preserveFormatting = true,
      autoDetectSource = false,
    } = options;

    try {
      const targetLangCode = this.getLanguageCode(targetLanguage);

      // Preprocess to protect certain content
      const { processed, placeholders } = preserveFormatting
        ? this.preprocessText(text)
        : { processed: text, placeholders: new Map() };

      const sourceLanguage = autoDetectSource ? 'auto' : 'en';

      // Check if text needs to be chunked
      if (processed.length > this.chunkSize) {
        this.logger.log(
          `Text too large (${processed.length} chars), splitting into chunks...`,
        );
        const chunks = this.splitTextIntoChunks(processed);
        this.logger.log(`Split into ${chunks.length} chunks`);

        const translatedChunks: string[] = [];
        for (let i = 0; i < chunks.length; i++) {
          this.logger.log(`Translating chunk ${i + 1}/${chunks.length}...`);
          const response = await this.retryRequest<LibreTranslateResponse>(() =>
            this.axiosInstance.post('/translate', {
              q: chunks[i],
              source: sourceLanguage,
              target: targetLangCode,
              format: format,
            }),
          );
          translatedChunks.push(response.data.translatedText);
        }

        const translated = translatedChunks.join('\n\n');
        const final = this.postprocessText(translated, placeholders);

        // Log untranslated words for quality check
        this.logUntranslatedWords(text, final, targetLanguage);

        return final;
      }

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

      this.logger.log(
        `Translated ${text.length} characters to ${targetLanguage}`,
      );

      // Log untranslated words for quality check
      this.logUntranslatedWords(text, final, targetLanguage);

      return final;
    } catch (error) {
      this.logger.error(`Translation error to ${targetLanguage}:`, error);
      throw error;
    }
  }

  /**
   * Batch translate with reduced concurrency and better error handling
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

      // Reduced concurrency for stability
      const concurrencyLimit = 2;
      const results: string[] = new Array(texts.length).fill('');

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
            this.logger.error(
              `Failed to translate text at index ${index}:`,
              error,
            );
            return { index, translation: text, success: false };
          }
        });

        const batchResults = await Promise.all(promises);
        batchResults.forEach(({ index, translation, success }) => {
          results[index] = translation;
          if (!success) {
            this.logger.warn(
              `Using original text for index ${index} due to translation failure`,
            );
          }
        });

        this.logger.log(
          `Batch translated ${Math.min(i + concurrencyLimit, textIndexMap.length)}/${textIndexMap.length} texts to ${targetLanguage}`,
        );

        // Add delay between batches
        if (i + concurrencyLimit < textIndexMap.length) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      this.logger.log(
        `Completed batch translation of ${texts.length} texts to ${targetLanguage}`,
      );

      return results;
    } catch (error) {
      this.logger.error(`Batch translation error to ${targetLanguage}:`, error);
      throw error;
    }
  }

  /**
   * Translate chapters sequentially with progress tracking
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
      `Starting sequential translation of ${chapters.length} chapters to ${targetLanguage}...`,
    );

    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i];

      try {
        this.logger.log(
          `Translating chapter ${i + 1}/${chapters.length}: ${chapter.title}`,
        );

        // Translate title and content separately
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

        if (onProgress) {
          onProgress(i + 1, chapters.length);
        }

        this.logger.log(`Completed chapter ${i + 1}/${chapters.length}`);

        // Small delay between chapters
        if (i < chapters.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (error) {
        this.logger.error(`Failed to translate chapter ${i + 1}:`, error);
        // Fallback to original content
        translatedChapters.push({
          title: chapter.title,
          content: chapter.content,
          order: chapter.order,
        });
      }
    }

    return translatedChapters;
  }

  /**
   * Translate metadata with options
   */
  async translateMetadata(
    title: string,
    subtitle: string,
    targetLanguage: Language,
    options: TranslationOptions = {},
  ): Promise<{ title: string; subtitle: string }> {
    try {
      const [translatedTitle, translatedSubtitle] = await Promise.all([
        this.translateText(title, targetLanguage, {
          ...options,
          format: 'text',
        }),
        subtitle
          ? this.translateText(subtitle, targetLanguage, {
              ...options,
              format: 'text',
            })
          : Promise.resolve(''),
      ]);

      return {
        title: translatedTitle,
        subtitle: translatedSubtitle,
      };
    } catch (error) {
      this.logger.error('Metadata translation failed:', error);
      return { title, subtitle };
    }
  }

  /**
   * Get supported languages from LibreTranslate
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
   * Detect language of given text
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
   * Map internal Language enum to LibreTranslate language codes
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
   * Retry failed requests with exponential backoff
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
            `Request failed, retrying in ${delay}ms... (attempt ${attempt + 1}/${retries})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }

  /**
   * Validate translation quality by checking if significant content was translated
   */
  async validateTranslation(
    original: string,
    translated: string,
    targetLanguage: Language,
  ): Promise<{ isValid: boolean; issues: string[] }> {
    const issues: string[] = [];

    // Check if translation is empty
    if (!translated || translated.trim().length === 0) {
      issues.push('Translation is empty');
      return { isValid: false, issues };
    }

    // Check if translation is identical to original (might indicate failure)
    if (original.trim() === translated.trim()) {
      issues.push('Translation is identical to original text');
    }

    // Check if translation is significantly shorter than original
    const lengthRatio = translated.length / original.length;
    if (lengthRatio < 0.5) {
      issues.push(
        `Translation is significantly shorter (${(lengthRatio * 100).toFixed(1)}% of original length)`,
      );
    }

    // Check for untranslated English content
    const englishWordPattern = /\b[a-zA-Z]{5,}\b/g;
    const originalWords: string[] = original.match(englishWordPattern) || [];
    const translatedWords: string[] =
      translated.match(englishWordPattern) || [];

    const untranslatedCount = translatedWords.filter(
      (word: string) =>
        originalWords.includes(word) && !this.isCommonWord(word),
    ).length;

    if (untranslatedCount > originalWords.length * 0.3) {
      issues.push(
        `High number of untranslated words detected (${untranslatedCount}/${originalWords.length})`,
      );
    }
    return {
      isValid: issues.length === 0,
      issues,
    };
  }
}
