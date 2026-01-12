// src/translation/google-translation.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Translate } from '@google-cloud/translate/build/src/v2';
import { Language } from 'src/DB/entities';

@Injectable()
export class GoogleTranslationService {
  private readonly logger = new Logger(GoogleTranslationService.name);
  private translate: Translate;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('GOOGLE_TRANSLATE_API_KEY');

    if (!apiKey) {
      throw new Error('GOOGLE_TRANSLATE_API_KEY must be configured');
    }

    this.translate = new Translate({ key: apiKey });
    this.logger.log('Google Translate service initialized');
  }

  async translateText(text: string, targetLanguage: Language): Promise<string> {
    try {
      const targetLangCode = this.getLanguageCode(targetLanguage);

      const [translation] = await this.translate.translate(text, {
        from: 'en',
        to: targetLangCode,
        format: 'text',
      });

      this.logger.log(
        `Translated ${text.length} characters to ${targetLanguage}`,
      );

      return translation;
    } catch (error) {
      this.logger.error(`Translation error to ${targetLanguage}:`, error);
      throw error;
    }
  }

  async translateBatch(
    texts: string[],
    targetLanguage: Language,
  ): Promise<string[]> {
    try {
      const targetLangCode = this.getLanguageCode(targetLanguage);

      const [translations] = await this.translate.translate(texts, {
        from: 'en',
        to: targetLangCode,
        format: 'text',
      });

      this.logger.log(
        `Batch translated ${texts.length} texts to ${targetLanguage}`,
      );

      return Array.isArray(translations) ? translations : [translations];
    } catch (error) {
      this.logger.error(`Batch translation error to ${targetLanguage}:`, error);
      throw error;
    }
  }

  async translateChapters(
    chapters: any[],
    targetLanguage: Language,
  ): Promise<any[]> {
    type TranslatedChapter = {
      title: string;
      content: string;
      order: number;
    };

    const translatedChapters: TranslatedChapter[] = [];

    // Batch translate all titles and contents together for better performance
    const titles = chapters.map((ch) => ch.title);
    const contents = chapters.map((ch) => ch.content);

    this.logger.log(`Batch translating ${chapters.length} chapter titles...`);
    const translatedTitles = await this.translateBatch(titles, targetLanguage);

    this.logger.log(`Batch translating ${chapters.length} chapter contents...`);
    const translatedContents = await this.translateBatch(
      contents,
      targetLanguage,
    );

    for (let i = 0; i < chapters.length; i++) {
      translatedChapters.push({
        title: translatedTitles[i],
        content: translatedContents[i],
        order: chapters[i].order,
      });
    }

    return translatedChapters;
  }

  async translateMetadata(
    title: string,
    subtitle: string,
    targetLanguage: Language,
  ): Promise<{ title: string; subtitle: string }> {
    const textsToTranslate = subtitle ? [title, subtitle] : [title];
    const translations = await this.translateBatch(
      textsToTranslate,
      targetLanguage,
    );

    return {
      title: translations[0],
      subtitle: subtitle ? translations[1] : '',
    };
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
