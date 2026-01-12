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
}

@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  private apiProviders: APIProvider[] = [];
  private currentProviderIndex: number = 0;
  private readonly MAX_RETRIES = 5;
  private readonly INITIAL_RETRY_DELAY = 6000;

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
    // Load Gemini API keys (multiple)
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

    // Add Gemini providers
    const uniqueGeminiKeys = [...new Set(geminiKeys)];
    uniqueGeminiKeys.forEach((key) => {
      this.apiProviders.push({
        type: 'gemini',
        client: new GoogleGenerativeAI(key),
        model: 'gemini-2.5-flash-lite',
      });
    });

    // Load OpenAI API key (single)
    const openaiKey = this.configService.get<string>('OPENAI_API_KEY');

    if (openaiKey) {
      this.apiProviders.push({
        type: 'openai',
        client: new OpenAI({ apiKey: openaiKey }),
        model: 'gpt-4.1-nano',
      });
    }
  }

  private getNextProvider(): APIProvider {
    const provider = this.apiProviders[this.currentProviderIndex];
    this.currentProviderIndex =
      (this.currentProviderIndex + 1) % this.apiProviders.length;

    this.logger.debug(
      `Using ${provider.type} provider (${this.currentProviderIndex}/${this.apiProviders.length})`,
    );

    return provider;
  }

  private async generateWithProvider(
    provider: APIProvider,
    prompt: string,
  ): Promise<string> {
    if (provider.type === 'gemini') {
      const model = (provider.client as GoogleGenerativeAI).getGenerativeModel({
        model: provider.model,
      });
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } else {
      // OpenAI
      const completion = await (
        provider.client as OpenAI
      ).chat.completions.create({
        model: provider.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
      });
      return completion.choices[0]?.message?.content || '';
    }
  }

  private async generateWithProviderRotation(prompt: string): Promise<string> {
    const providersToTry = this.apiProviders.length;
    let lastError: any;

    for (let attempt = 0; attempt < providersToTry; attempt++) {
      const provider = this.getNextProvider();

      try {
        this.logger.log(
          `Attempting with ${provider.type} provider (${attempt + 1}/${providersToTry})...`,
        );
        return await this.generateWithProvider(provider, prompt);
      } catch (error: any) {
        lastError = error;
        const isRateLimitError =
          error?.status === 429 ||
          error?.message?.includes('rate limit') ||
          error?.message?.includes('quota');

        if (isRateLimitError && attempt < providersToTry - 1) {
          this.logger.warn(
            `${provider.type} provider rate limited, trying next provider...`,
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

  async generateText(prompt: string): Promise<string> {
    let lastError: any;

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        this.logger.log(
          `Generating content (attempt ${attempt}/${this.MAX_RETRIES})...`,
        );

        const text = await this.generateWithProviderRotation(prompt);

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

  async generateBookOutline(
    title: string,
    subtitle: string,
    numberOfChapters: number,
  ): Promise<BookOutlineDto> {
    const prompt = `You are a professional travel guide book writer. Create a detailed ${numberOfChapters}-chapter outline for a travel guide book.

Book Title: "${title}"
Subtitle: "${subtitle}"

REQUIREMENTS:
1. Start with an Introduction chapter
2. Create ${numberOfChapters - 2} main content chapters (chapters 2-${numberOfChapters - 1})
3. End with a Conclusion chapter (chapter ${numberOfChapters})
4. Each chapter must have exactly 3 sections
5. Each section must have exactly 3 subsections

STRUCTURE:
- Introduction: Set the stage, explain what makes this destination special, how to use the guide
- Main Chapters: Cover practical travel information, attractions, culture, food, activities, day trips
- Conclusion: Key takeaways, practical tips, emergency contacts

OUTPUT FORMAT (JSON):
{
  "chapters": [
    {
      "chapterNumber": 1,
      "chapterTitle": "Introduction",
      "sections": [
        {
          "sectionTitle": "Why [Destination] Pulls You In",
          "subsections": ["Unique characteristic 1", "Unique characteristic 2", "Unique characteristic 3"]
        },
        {
          "sectionTitle": "How to Use This Guide",
          "subsections": ["Understanding the structure", "Planning your trip", "Tips for navigation"]
        },
        {
          "sectionTitle": "What to Expect in 2026",
          "subsections": ["New developments", "Seasonal patterns", "Cost expectations"]
        }
      ]
    }
  ]
}

Generate the complete outline now as valid JSON:`;

    const response = await this.generateText(prompt);

    const cleanedResponse = response
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    const outline = JSON.parse(cleanedResponse);

    return {
      title,
      subtitle,
      author: '',
      chapters: outline.chapters,
    };
  }

  async generateIntroduction(
    title: string,
    subtitle: string,
    outline: BookOutlineDto,
  ): Promise<string> {
    const introChapter = outline.chapters.find((c) => c.chapterNumber === 1);

    const prompt = `You are a professional travel guide book writer. Write the complete Introduction chapter for this travel guide:

Title: "${title}"
Subtitle: "${subtitle}"

Chapter Structure:
${JSON.stringify(introChapter, null, 2)}

WRITING STYLE:
- Use simple, engaging, conversational English
- Write in second person ("you") to connect with readers
- Use short paragraphs (3-5 sentences maximum)
- Include personal stories and examples
- Make it warm and inviting, not stiff or academic
- Focus on practical advice readers can actually use
- NO lists or bullet points - write in flowing prose

TONE:
- Friendly and helpful, like talking to a friend
- Honest and authentic
- Encouraging and exciting about the destination

LENGTH: Write approximately 600-700 words covering all sections and subsections from the outline.

Write the complete Introduction chapter now:`;

    return await this.generateText(prompt);
  }

  async generateChapterContent(
    chapterOutline: ChapterOutline,
    bookTitle: string,
    bookSubtitle: string,
  ): Promise<string> {
    const prompt = `You are a professional travel guide book writer. Write Chapter ${chapterOutline.chapterNumber}: "${chapterOutline.chapterTitle}" for the travel guide "${bookTitle}: ${bookSubtitle}".

Chapter Structure:
${JSON.stringify(chapterOutline, null, 2)}

WRITING STYLE:
- Use simple, engaging, conversational English
- Write in second person ("you") to connect with readers
- Use short paragraphs (3-5 sentences maximum)
- Include personal stories, anecdotes, and examples to make information personal
- Share travel experiences: "I once..." or "A traveler told me..."
- Make it warm and inviting, not stiff or academic
- Focus on practical advice readers can actually use
- NO lists or bullet points in the main content - write in flowing prose
- Paint pictures with words - help readers visualize the experience

CONTENT APPROACH:
- Open each section with a personal story or vivid scene
- Weave practical information into narrative form
- Use specific details (names, times, places) to add authenticity
- Include sensory details (sounds, smells, sights, tastes)
- Share insider tips naturally within the narrative
- Reference local people and their habits
- Explain the "why" behind recommendations, not just the "what"

TONE:
- Friendly and helpful, like a knowledgeable friend sharing secrets
- Honest and authentic - mention both positives and challenges
- Encouraging and exciting about the destination
- Patient and understanding of different travel styles

LENGTH: Write approximately 1,000-1,100 words covering all sections and subsections from the outline.

Write the complete chapter now:`;

    return await this.generateText(prompt);
  }

  async generateConclusion(
    title: string,
    subtitle: string,
    outline: BookOutlineDto,
  ): Promise<string> {
    const conclusionChapter = outline.chapters.find(
      (c) => c.chapterNumber === outline.chapters.length,
    );

    const prompt = `You are a professional travel guide book writer. Write the Conclusion chapter for this travel guide:

Title: "${title}"
Subtitle: "${subtitle}"

Chapter Structure:
${JSON.stringify(conclusionChapter, null, 2)}

WRITING STYLE FOR CONCLUSION:
- Start with a warm, reflective paragraph summarizing the journey
- For practical sections, you CAN use lists and bullet points
- Keep it encouraging and inspiring
- End with emergency contacts in a clear list format

STRUCTURE:
1. Opening paragraph: Reflective, warm prose about the trip experience
2. Key Takeaways: Use bullet points for clarity
3. Practical Tips: Use lists for easy reference
4. Final Encouragement: Return to prose, inspiring and warm
5. Emergency Contacts: Clear list with phone numbers

LENGTH: Write approximately 600-650 words.

Write the complete Conclusion chapter now:`;

    return await this.generateText(prompt);
  }

  async generateTableOfContents(outline: BookOutlineDto): Promise<string> {
    let toc = 'Table of Contents\n\n';

    outline.chapters.forEach((chapter) => {
      toc += `Chapter ${chapter.chapterNumber}\n`;
      toc += `${chapter.chapterTitle}\n\n`;

      chapter.sections.forEach((section) => {
        toc += `  ${section.sectionTitle}\n`;
        section.subsections.forEach((subsection) => {
          toc += `    ${subsection}\n`;
        });
        toc += '\n';
      });
      toc += '\n';
    });

    return toc;
  }

  async generateFrontMatter(
    title: string,
    subtitle: string,
    author: string,
  ): Promise<string> {
    return `${title}
${subtitle}


(Including a map at the Last Page)



By
${author}`;
  }

  async generateCopyright(author: string, year: number): Promise<string> {
    return `Copyright © 2026 ${author}. All rights reserved.

No part of this book may be reproduced, stored in a research system, or transmitted in any form or by any means, electronic, mechanical, photocopying, recording, or otherwise, without the prior written permission of the publisher, except for the use of brief quotations in a review or academic work.`;
  }

  async generateAboutBook(title: string): Promise<string> {
    const prompt = `Write an "About Book" section for a travel guide titled "${title}". 

This should be 2-3 paragraphs explaining:
- What makes this guide different from typical travel guides
- Who this guide is for (solo travelers, couples, families, etc.)
- The practical approach and flexibility built into the guide
- How it helps readers create their own path

STYLE: Warm, inviting, and practical. Make readers feel confident about using this guide.

Write the About Book section now:`;

    return await this.generateText(prompt);
  }
}
