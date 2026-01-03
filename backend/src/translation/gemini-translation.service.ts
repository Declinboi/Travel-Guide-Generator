import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Language } from 'src/DB/entities';
// import { Language } from '../../entities/translation.entity';

@Injectable()
export class GeminiTranslationService {
  private readonly logger = new Logger(GeminiTranslationService.name);
  private genAI: GoogleGenerativeAI;
  private model: any;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not configured');
    }
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-pro' });
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

      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      const translatedText = response.text();

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
    const translatedChapters = [];

    for (const chapter of chapters) {
      this.logger.log(`Translating chapter: ${chapter.title}`);

      const translatedTitle = await this.translateText(
        chapter.title,
        targetLanguage,
        false, // Titles don't need style preservation
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
