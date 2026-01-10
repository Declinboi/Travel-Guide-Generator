// src/content/gemini.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  BookOutlineDto,
  ChapterOutline,
} from './dto/generate-travel-guide.dto';

@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  private apiKeys: string[];
  private currentKeyIndex: number = 0;
  private genAIInstances: GoogleGenerativeAI[];
  private readonly MODEL_NAME = 'gemini-2.5-flash-lite';
  private readonly MAX_RETRIES = 5;
  private readonly INITIAL_RETRY_DELAY = 6000;

  constructor(private configService: ConfigService) {
    // Load multiple API keys from environment
    const primaryKey = this.configService.get<string>('GEMINI_API_KEY');
    const secondaryKeys = this.configService.get<string>('GEMINI_API_KEYS'); // Comma-separated list

    if (!primaryKey && !secondaryKeys) {
      throw new Error('At least one GEMINI_API_KEY must be configured');
    }

    // Build array of API keys
    this.apiKeys = [];
    if (primaryKey) {
      this.apiKeys.push(primaryKey);
    }
    if (secondaryKeys) {
      const keys = secondaryKeys
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k);
      this.apiKeys.push(...keys);
    }

    // Remove duplicates
    this.apiKeys = [...new Set(this.apiKeys)];

    // Create GoogleGenerativeAI instance for each key
    this.genAIInstances = this.apiKeys.map(
      (key) => new GoogleGenerativeAI(key),
    );

    this.logger.log(
      `Gemini service initialized with ${this.apiKeys.length} API key(s)`,
    );
    this.logger.log(`Using model: ${this.MODEL_NAME}`);
  }

  /**
   * Get the next API key in round-robin fashion
   */
  private getNextModel(): any {
    const genAI = this.genAIInstances[this.currentKeyIndex];
    const model = genAI.getGenerativeModel({ model: this.MODEL_NAME });

    // Rotate to next key for next request
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;

    this.logger.debug(
      `Using API key ${this.currentKeyIndex + 1}/${this.apiKeys.length}`,
    );

    return model;
  }

  /**
   * Try all available API keys before giving up
   */
  private async generateWithKeyRotation(prompt: string): Promise<string> {
    const keysToTry = this.apiKeys.length;
    let lastError: any;

    for (let keyAttempt = 0; keyAttempt < keysToTry; keyAttempt++) {
      const model = this.getNextModel();

      try {
        this.logger.log(
          `Attempting with API key ${keyAttempt + 1}/${keysToTry}...`,
        );
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
      } catch (error: any) {
        lastError = error;
        const isRateLimitError =
          error?.status === 429 ||
          error?.message?.includes('rate limit') ||
          error?.message?.includes('quota');

        if (isRateLimitError && keyAttempt < keysToTry - 1) {
          this.logger.warn(
            `API key ${keyAttempt + 1} rate limited, trying next key...`,
          );
          continue;
        }

        // If not a rate limit error, or last key, throw
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

        // Try with key rotation first
        const text = await this.generateWithKeyRotation(prompt);

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
            // Exponential backoff: 2s, 4s, 8s, 16s, 32s
            const delay = this.INITIAL_RETRY_DELAY * Math.pow(2, attempt - 1);
            this.logger.warn(
              `All keys overloaded/rate limited (attempt ${attempt}/${this.MAX_RETRIES}). Retrying in ${delay}ms...`,
            );
            await this.sleep(delay);
            continue;
          }
        }

        this.logger.error('Error generating content with Gemini:', error);
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

    // Clean and parse JSON response
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
