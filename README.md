# Kickstarter Pre-Launch Follower Tracker

Track your Kickstarter pre-launch **"Notify Me" follower count** and project details automatically. Schedule it daily to monitor your campaign's pre-launch growth over time.

## Why this actor?

Every Kickstarter creator running ads to their pre-launch page needs to track daily follower growth — but Kickstarter's own dashboard gives you limited visibility. This actor solves that by:

- **Scraping the live follower count** from any Kickstarter pre-launch page
- **Extracting full project details**: name, creator, category, description, location
- **Working with both pre-launch AND live campaigns** (also captures backer count when available)
- **Outputting structured data** you can pipe into Notion, Google Sheets, or any analytics tool

## Use cases

- **Daily follower growth tracking** — Schedule this actor to run once per day and build a time series of your "Notify Me" count
- **Competitor monitoring** — Track how fast competing campaigns are growing their pre-launch audience
- **Ad performance correlation** — Compare daily follower growth against your Meta/TikTok ad spend
- **Launch readiness assessment** — Know exactly when you've hit your target follower count

## How to use

1. **Enter your Kickstarter project URL** — e.g. `https://www.kickstarter.com/projects/your-name/your-project`
2. **Run the actor** — it will launch a browser, load the page, and extract all available data
3. **Get structured results** — download as JSON, CSV, or Excel from the dataset

### Scheduling for daily tracking

To track follower growth over time:

1. Go to **Schedules** in your Apify Console
2. Create a new schedule (e.g., daily at 9:00 AM UTC)
3. Link it to this actor with your project URL as input
4. Use a **named dataset** so all runs append to the same dataset
5. Connect the dataset to Google Sheets or Notion via webhook/integration

## Output format

Each run produces a single record with these fields:

| Field | Description |
|-------|-------------|
| `url` | The Kickstarter project URL |
| `projectName` | Project title |
| `creatorName` | Creator's name |
| `category` | Primary category (e.g., Technology, Design) |
| `subcategory` | Subcategory if available |
| `description` | Project blurb / short description |
| `followerCount` | **"Notify Me" count** (null if < 10, as Kickstarter hides it) |
| `location` | Creator's listed location |
| `backerCount` | Number of backers (live/completed projects) |
| `scrapedAt` | ISO 8601 timestamp of the scrape |

### Example output (pre-launch)

```json
{
    "url": "https://www.kickstarter.com/projects/creator/awesome-product",
    "projectName": "Awesome Product - The Future of Coffee Storage",
    "creatorName": "Awesome Creator",
    "category": "Technology",
    "subcategory": "Gadgets",
    "description": "A revolutionary modular storage system for coffee pods and beans.",
    "followerCount": 847,
    "location": "San Francisco, CA",
    "backerCount": null,
    "scrapedAt": "2026-03-04T10:30:00.000Z"
}
```

## Input configuration

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | Yes | — | Kickstarter project URL |
| `waitForSelectorTimeout` | integer | No | 30000 | Page load timeout in ms |
| `proxyConfiguration` | object | No | — | Proxy settings (residential recommended) |

## Tips

- **Kickstarter hides follower count below 10** — the actor will return `null` for `followerCount` until the project crosses 10 followers
- **Use residential proxies** for the most stable results if you're running this frequently
- **Use Apify integrations or webhooks** to automatically log each day's count into Notion, Google Sheets, or your own API
- The actor works with projects in **any state** — pre-launch, live, successfully funded, or canceled

## Cost

Pricing is **$0.05 per request**.

## Technical details

- Built with [Crawlee](https://crawlee.dev) + Playwright (headless Chrome)
- Multi-strategy extraction: embedded JSON data → DOM scraping → text pattern matching
- Handles Kickstarter's client-side rendering (React/Next.js)
- Automatic retries on failure (3 attempts)
