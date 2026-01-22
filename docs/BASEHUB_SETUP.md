# BaseHub CMS Setup Instructions

This document outlines the schema you need to create in your BaseHub workspace for the marketing pages CMS integration.

## Required Content Types

### HomePage

Create a new content type called `HomePage` with the following block fields:

#### hero
- `title` (Text)
- `description` (Text)
- `primaryButtonText` (Text)
- `primaryButtonHref` (Text)
- `secondaryButtonText` (Text)
- `secondaryButtonHref` (Text)

#### cases
- `title` (Text)
- `logos` (Repeater of blocks):
  - `image` (Image)
  - `alt` (Text)
  - `href` (Text, optional)

#### features
- `title` (Text)
- `description` (Text)
- `items` (Repeater of blocks):
  - `title` (Text)
  - `description` (Text)
  - `icon` (Text) - Name of Lucide icon (e.g., "User", "Zap", "Check")

####stats
- `title` (Text)
- `description` (Text)
- `items` (Repeater of blocks):
  - `title` (Text)
  - `metric` (Text)
  - `delta` (Text) - Percentage change
  - `type` (Text) - "unit" or "currency"

#### testimonials
- `title` (Text)
- `items` (Repeater of blocks):
  - `title` (Text)
  - `description` (Text)
  - `authorName` (Text)
  - `authorImage` (Image)

#### faq
- `title` (Text)
- `description` (Text)
- `ctaText` (Text)
- `items` (Repeater of blocks):
  - `question` (Text)
  - `answer` (Text)

#### cta
- `title` (Text)
- `description` (Text)
- `secondaryDescription` (Text, optional)
- `primaryButtonText` (Text)
- `primaryButtonHref` (Text)
- `secondaryButtonText` (Text)
- `secondaryButtonHref` (Text)

## After Creating Schema

1. BaseHub will regenerate TypeScript types automatically
2. Build will succeed once the `homepage` content type exists
3. Create content for each section in BaseHub UI
4. Site will use CMS content where available, dictionary fallback otherwise

## Testing

- **Without content**: Site uses dictionary (current static behavior)
- **With content**: Site uses BaseHub CMS content
- **Partial content**: Mix of CMS and dictionary per section
