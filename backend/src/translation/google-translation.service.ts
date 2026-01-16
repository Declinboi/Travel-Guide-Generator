// src/translation/libre-translation.service.ts
import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Language } from 'src/DB/entities';
import axios, { AxiosInstance } from 'axios';

interface LibreTranslateResponse {
  translatedText: string;
}

@Injectable()
export class LibreTranslationService {
  private readonly logger = new Logger(LibreTranslationService.name);
  private readonly axiosInstance: AxiosInstance;
  private readonly apiUrl: string;
  private readonly apiKey: string | null;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly chunkSize: number; // For splitting large texts

  constructor(private configService: ConfigService) {
    this.apiUrl =
      this.configService.get<string>('LIBRETRANSLATE_API_URL') ||
      'http://localhost:5000';
    this.apiKey =
      this.configService.get<string>('LIBRETRANSLATE_API_KEY') || null;
    // Increased timeout for large content
    this.timeout =
      this.configService.get<number>('LIBRETRANSLATE_TIMEOUT') || 120000; // 2 minutes
    this.maxRetries = 5;
    this.chunkSize = 3000; // Characters per chunk for large texts

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
      const response = await this.axiosInstance.get('/health');
      this.logger.log('LibreTranslate service is healthy');
    } catch (error) {
      this.logger.warn('LibreTranslate health check failed:', error.message);
    }
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
   * Translate a single text with chunking support
   */
  async translateText(text: string, targetLanguage: Language): Promise<string> {
    if (!text || text.trim().length === 0) {
      return '';
    }

    try {
      const targetLangCode = this.getLanguageCode(targetLanguage);

      // Check if text needs to be chunked
      if (text.length > this.chunkSize) {
        this.logger.log(
          `Text too large (${text.length} chars), splitting into chunks...`,
        );
        const chunks = this.splitTextIntoChunks(text);
        this.logger.log(`Split into ${chunks.length} chunks`);

        const translatedChunks: string[] = [];
        for (let i = 0; i < chunks.length; i++) {
          this.logger.log(`Translating chunk ${i + 1}/${chunks.length}...`);
          const response = await this.retryRequest<LibreTranslateResponse>(() =>
            this.axiosInstance.post('/translate', {
              q: chunks[i],
              source: 'en',
              target: targetLangCode,
              format: 'text',
            }),
          );
          translatedChunks.push(response.data.translatedText);
        }

        return translatedChunks.join('\n\n');
      }

      const response = await this.retryRequest<LibreTranslateResponse>(() =>
        this.axiosInstance.post('/translate', {
          q: text,
          source: 'en',
          target: targetLangCode,
          format: 'text',
        }),
      );

      this.logger.log(
        `Translated ${text.length} characters to ${targetLanguage}`,
      );
      return response.data.translatedText;
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
  ): Promise<string[]> {
    if (texts.length === 0) {
      return [];
    }

    try {
      const targetLangCode = this.getLanguageCode(targetLanguage);

      const textIndexMap: { text: string; index: number }[] = [];
      texts.forEach((text, index) => {
        if (text && text.trim().length > 0) {
          textIndexMap.push({ text, index });
        }
      });

      // Reduced concurrency for stability - only 2 simultaneous translations
      const concurrencyLimit = 2;
      const results: string[] = new Array(texts.length).fill('');

      for (let i = 0; i < textIndexMap.length; i += concurrencyLimit) {
        const batch = textIndexMap.slice(i, i + concurrencyLimit);

        const promises = batch.map(async ({ text, index }) => {
          try {
            // Use translateText which handles chunking
            const translation = await this.translateText(text, targetLanguage);
            return { index, translation, success: true };
          } catch (error) {
            this.logger.error(
              `Failed to translate text at index ${index}:`,
              error,
            );
            // Return original text as fallback
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

        // Add delay between batches to prevent overwhelming the service
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
  ): Promise<any[]> {
    const translatedChapters: Array<{
      title: string;
      content: string;
      order: number;
    }> = [];

    this.logger.log(
      `Starting sequential translation of ${chapters.length} chapters to ${targetLanguage}...`,
    );

    // Translate one chapter at a time to avoid overwhelming the service
    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i];

      try {
        this.logger.log(
          `Translating chapter ${i + 1}/${chapters.length}: ${chapter.title}`,
        );

        // Translate title and content separately
        const [translatedTitle, translatedContent] = await Promise.all([
          this.translateText(chapter.title, targetLanguage),
          this.translateText(chapter.content, targetLanguage),
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

  async translateMetadata(
    title: string,
    subtitle: string,
    targetLanguage: Language,
  ): Promise<{ title: string; subtitle: string }> {
    try {
      const [translatedTitle, translatedSubtitle] = await Promise.all([
        this.translateText(title, targetLanguage),
        subtitle
          ? this.translateText(subtitle, targetLanguage)
          : Promise.resolve(''),
      ]);

      return {
        title: translatedTitle,
        subtitle: translatedSubtitle,
      };
    } catch (error) {
      this.logger.error('Metadata translation failed:', error);
      // Fallback to original
      return { title, subtitle };
    }
  }

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
    const languageMap = {
      [Language.ENGLISH]: 'en',
      [Language.GERMAN]: 'de',
      [Language.FRENCH]: 'fr',
      [Language.SPANISH]: 'es',
      [Language.ITALIAN]: 'it',
    };
    return languageMap[language] || 'en';
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
            `Request failed, retrying in ${delay}ms... (attempt ${attempt + 1}/${retries})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }
}
