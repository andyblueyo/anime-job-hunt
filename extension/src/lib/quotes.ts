// Motivational line for the lock screen. AnimeChan primary (free tier: 100
// req/day/IP, no key — https://animechan.io/docs), small local fallback list
// if it errors, is rate-limited, or the network is down. Cached in the
// background service worker's memory and refreshed on a cooldown so a
// binge-watching session doesn't burn through the daily quota.

const ANIMECHAN_RANDOM_URL = "https://api.animechan.io/v1/quotes/random";
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000; // one fetch per 5 minutes at most

const LOCAL_FALLBACK: Array<{ quote: string; author: string | null }> = [
  { quote: "A dropout will beat a genius through hard work.", author: "Rock Lee, Naruto" },
  {
    quote: "If you don't take risks, you can't create a future.",
    author: "Monkey D. Luffy, One Piece",
  },
  {
    quote: "Whatever you do, enjoy it to the fullest. That is the secret of life.",
    author: "Kenshin Himura, Rurouni Kenshin",
  },
  {
    quote: "It's not the face that makes someone a monster; it's the choices they make with their lives.",
    author: "Naruto Uzumaki, Naruto",
  },
  {
    quote: "Being alone is more painful than getting hurt.",
    author: "Naruto Uzumaki, Naruto",
  },
  { quote: "The world isn't perfect. But it's there for us, doing the best it can.", author: "Roy Mustang, Fullmetal Alchemist" },
];

interface CachedQuote {
  quote: string;
  author: string | null;
  fetchedAt: number;
}

let cache: CachedQuote | null = null;

function pickFallback(): { quote: string; author: string | null } {
  return LOCAL_FALLBACK[Math.floor(Math.random() * LOCAL_FALLBACK.length)];
}

interface AnimechanQuoteResponse {
  status: string;
  data: {
    content: string;
    anime: { id: number; name: string };
    character: { id: number; name: string };
  };
}

export async function getQuote(): Promise<{ quote: string; author: string | null }> {
  if (cache && Date.now() - cache.fetchedAt < REFRESH_COOLDOWN_MS) {
    return { quote: cache.quote, author: cache.author };
  }

  try {
    const response = await fetch(ANIMECHAN_RANDOM_URL);
    if (!response.ok) throw new Error(`animechan ${response.status}`);
    const body = (await response.json()) as AnimechanQuoteResponse;
    const quote = body.data.content;
    const author = `${body.data.character.name}, ${body.data.anime.name}`;
    cache = { quote, author, fetchedAt: Date.now() };
    return { quote, author };
  } catch {
    const fallback = pickFallback();
    // Cache the fallback too, briefly, so a sustained outage doesn't retry
    // on every single poll tick.
    cache = { ...fallback, fetchedAt: Date.now() };
    return fallback;
  }
}
