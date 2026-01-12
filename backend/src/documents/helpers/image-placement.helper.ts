// src/modules/document/helpers/image-placement.helper.ts
/**
 * Helper for smart image placement within text content
 * Ensures images are well-spaced and don't break content flow awkwardly
 */

export interface ImagePlacementConfig {
  totalParagraphs: number;
  imageCount: number;
  minParagraphsBeforeImage?: number;
  minParagraphsAfterImage?: number;
}

export interface ImagePlacement {
  imageIndex: number;
  insertAfterParagraph: number;
}

/**
 * Calculate optimal positions for images within text
 * Distributes images evenly and ensures minimum spacing
 */
export function calculateImagePositions(
  config: ImagePlacementConfig,
): ImagePlacement[] {
  const {
    totalParagraphs,
    imageCount,
    minParagraphsBeforeImage = 2,
    minParagraphsAfterImage = 2,
  } = config;

  const placements: ImagePlacement[] = [];

  if (
    imageCount === 0 ||
    totalParagraphs < minParagraphsBeforeImage + minParagraphsAfterImage
  ) {
    return placements;
  }

  // Calculate usable space (excluding required margins)
  const usableSpace = totalParagraphs - minParagraphsAfterImage;

  // Distribute images evenly
  const spacing = Math.floor(usableSpace / (imageCount + 1));

  for (let i = 0; i < imageCount; i++) {
    const position = Math.min(
      minParagraphsBeforeImage + spacing * (i + 1),
      totalParagraphs - minParagraphsAfterImage - (imageCount - i - 1),
    );

    placements.push({
      imageIndex: i,
      insertAfterParagraph: position,
    });
  }

  return placements;
}

/**
 * Split content into sections with images
 */
export interface ContentSection {
  paragraphs: string[];
  imageIndex?: number; // If present, insert image after this section
}

export function createContentSections(
  paragraphs: string[],
  imageCount: number,
): ContentSection[] {
  const sections: ContentSection[] = [];

  if (imageCount === 0) {
    sections.push({ paragraphs });
    return sections;
  }

  const placements = calculateImagePositions({
    totalParagraphs: paragraphs.length,
    imageCount,
    minParagraphsBeforeImage: 2,
    minParagraphsAfterImage: 2,
  });

  let lastIndex = 0;

  placements.forEach((placement, idx) => {
    const sectionParagraphs = paragraphs.slice(
      lastIndex,
      placement.insertAfterParagraph,
    );

    sections.push({
      paragraphs: sectionParagraphs,
      imageIndex: placement.imageIndex,
    });

    lastIndex = placement.insertAfterParagraph;
  });

  // Add remaining paragraphs
  if (lastIndex < paragraphs.length) {
    sections.push({
      paragraphs: paragraphs.slice(lastIndex),
    });
  }

  return sections;
}

// Example usage:
/*
const paragraphs = content.split('\n\n').filter(p => p.trim());
const sections = createContentSections(paragraphs, chapterImages.length);

sections.forEach(section => {
  // Add text
  addFormattedContent(section.paragraphs.join('\n\n'));
  
  // Add image if this section has one
  if (section.imageIndex !== undefined) {
    const image = chapterImages[section.imageIndex];
    await insertImage(image);
  }
});
*/
