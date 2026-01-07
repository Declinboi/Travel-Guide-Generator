// src/translation/gemini-translation.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Language } from 'src/DB/entities';

@Injectable()
export class GeminiTranslationService {
  private readonly logger = new Logger(GeminiTranslationService.name);
  private apiKeys: string[];
  private currentKeyIndex: number = 0;
  private genAIInstances: GoogleGenerativeAI[];
  private readonly MODEL_NAME = 'gemini-2.5-flash-lite';
  private readonly MAX_RETRIES = 5;
  private readonly INITIAL_RETRY_DELAY = 6000;

  constructor(private configService: ConfigService) {
    // Load multiple API keys from environment
    const primaryKey = this.configService.get<string>('GEMINI_API_KEY');
    const secondaryKeys = this.configService.get<string>('GEMINI_API_KEYS');

    if (!primaryKey && !secondaryKeys) {
      throw new Error('At least one GEMINI_API_KEY must be configured');
    }

    // Build array of API keys
    this.apiKeys = [];
    if (primaryKey) {
      this.apiKeys.push(primaryKey);
    }
    if (secondaryKeys) {
      const keys = secondaryKeys.split(',').map(k => k.trim()).filter(k => k);
      this.apiKeys.push(...keys);
    }

    // Remove duplicates
    this.apiKeys = [...new Set(this.apiKeys)];

    // Create GoogleGenerativeAI instance for each key
    this.genAIInstances = this.apiKeys.map(key => new GoogleGenerativeAI(key));

    this.logger.log(`Gemini Translation service initialized with ${this.apiKeys.length} API key(s)`);
  }

  private getNextModel(): any {
    const genAI = this.genAIInstances[this.currentKeyIndex];
    const model = genAI.getGenerativeModel({ model: this.MODEL_NAME });
    
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    
    return model;
  }

  private async generateWithKeyRotation(prompt: string): Promise<string> {
    const keysToTry = this.apiKeys.length;
    let lastError: any;

    for (let keyAttempt = 0; keyAttempt < keysToTry; keyAttempt++) {
      const model = this.getNextModel();
      
      try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
      } catch (error: any) {
        lastError = error;
        const isRateLimitError = error?.status === 429 || 
                                 error?.message?.includes('rate limit') ||
                                 error?.message?.includes('quota');
        
        if (isRateLimitError && keyAttempt < keysToTry - 1) {
          this.logger.warn(
            `Translation API key ${keyAttempt + 1} rate limited, trying next key...`
          );
          continue;
        }
        
        throw error;
      }
    }

    throw lastError;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async generateTextWithRetry(prompt: string): Promise<string> {
    let lastError: any;

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const text = await this.generateWithKeyRotation(prompt);
        return text;
      } catch (error: any) {
        lastError = error;
        const is503Error = error?.status === 503 || error?.message?.includes('overloaded');
        const is429Error = error?.status === 429 || error?.message?.includes('rate limit');
        
        if (is503Error || is429Error) {
          if (attempt < this.MAX_RETRIES) {
            const delay = this.INITIAL_RETRY_DELAY * Math.pow(2, attempt - 1);
            this.logger.warn(
              `All translation keys overloaded (attempt ${attempt}/${this.MAX_RETRIES}). Retrying in ${delay}ms...`
            );
            await this.sleep(delay);
            continue;
          }
        }
        
        throw error;
      }
    }

    throw lastError;
  }

  async translateText(
    text: string,
    targetLanguage: Language,
    maintainStyle: boolean = true,
  ): Promise<string> {
    try {
      const languageName = this.getLanguageName(targetLanguage);

      const styleInstructions = maintainStyle
        ? `CRITICAL: Maintain the exact same conversational, personal tone as the original. This is a travel guide written in a warm, friendly style with personal anecdotes. Keep:
- The second person "you" perspective
- Personal stories (translate "I once..." naturally)
- Short, easy-to-read paragraphs
- The warm, inviting tone
- Sensory descriptions and vivid language
- Natural flow, not stiff or academic`
        : 'Translate accurately while maintaining clarity.';

      const prompt = `You are a professional translator specializing in travel guides. Translate the following English text to ${languageName}.

${styleInstructions}

TRANSLATION RULES:
1. Translate naturally for native speakers of ${languageName}
2. Adapt idioms and cultural references appropriately
3. Keep place names in their original form (e.g., "Piazza Unità" stays as is)
4. Maintain paragraph structure exactly
5. Preserve the conversational, storytelling style
6. Keep the same level of detail and description
7. Make it sound like it was originally written in ${languageName}, not translated

Original English text:
${text}

Provide ONLY the translated text, no explanations or notes:`;

      const translatedText = await this.generateTextWithRetry(prompt);

      this.logger.log(
        `Translated ${text.length} characters to ${languageName}`,
      );
      return translatedText;
    } catch (error) {
      this.logger.error(`Translation error to ${targetLanguage}:`, error);
      throw error;
    }
  }

  async translateChapters(
    chapters: any[],
    targetLanguage: Language,
    maintainStyle: boolean = true,
  ): Promise<any[]> {
    type TranslatedChapter = {
      title: string;
      content: string;
      order: number;
    };

    const translatedChapters: TranslatedChapter[] = [];

    for (const chapter of chapters) {
      this.logger.log(`Translating chapter: ${chapter.title}`);

      const translatedTitle = await this.translateText(
        chapter.title,
        targetLanguage,
        false,
      );

      const translatedContent = await this.translateText(
        chapter.content,
        targetLanguage,
        maintainStyle,
      );

      translatedChapters.push({
        title: translatedTitle,
        content: translatedContent,
        order: chapter.order,
      });
    }

    return translatedChapters;
  }

  async translateMetadata(
    title: string,
    subtitle: string,
    targetLanguage: Language,
  ): Promise<{ title: string; subtitle: string }> {
    const translatedTitle = await this.translateText(
      title,
      targetLanguage,
      false,
    );
    const translatedSubtitle = subtitle
      ? await this.translateText(subtitle, targetLanguage, false)
      : '';

    return {
      title: translatedTitle,
      subtitle: translatedSubtitle,
    };
  }

  private getLanguageName(language: Language): string {
    const languageMap = {
      [Language.ENGLISH]: 'English',
      [Language.GERMAN]: 'German',
      [Language.FRENCH]: 'French',
      [Language.SPANISH]: 'Spanish',
      [Language.ITALIAN]: 'Italian',
    };
    return languageMap[language] || 'English';
  }
}