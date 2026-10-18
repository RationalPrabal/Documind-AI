// Loads and validates environment variables once, at startup.
// If anything is missing or malformed the process exits immediately with a
// clear message, instead of failing later in the middle of a request.
import { z } from 'zod';

const int = (def) => z.coerce.number().int().positive().default(def);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: int(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    CORS_ORIGIN: z.string().default('http://localhost:5173'),
    // Signs the anonymous owner cookie so users cannot forge someone else's id.
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),

    MONGODB_URI: z
      .string()
      .regex(/^mongodb(\+srv)?:\/\//, 'MONGODB_URI must start with mongodb:// or mongodb+srv://')
      .refine((v) => !/<[^>]+>/.test(v), 'MONGODB_URI still contains a <placeholder> from .env.example'),
    MONGODB_DB: z.string().default('documind'),
    VECTOR_INDEX_NAME: z.string().default('chunk_vector_index'),

    OPENAI_API_KEY: z
      .string()
      .startsWith('sk-', 'OPENAI_API_KEY looks invalid')
      .refine((v) => v !== 'sk-...', 'OPENAI_API_KEY is still the placeholder from .env.example'),
    CHAT_MODEL: z.string().default('gpt-5.4-mini'),
    // Optional. Only for reasoning models; leave empty for models that reject it.
    REASONING_EFFORT: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.enum(['none', 'minimal', 'low', 'medium', 'high']).optional(),
    ),
    EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
    EMBEDDING_DIMENSIONS: int(1536),
    OPENAI_TIMEOUT_MS: int(30_000),
    OPENAI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

    MAX_UPLOAD_MB: int(10),
    MAX_PDF_PAGES: int(300),
    CHUNK_SIZE: int(1000), // characters (~250 tokens of English text)
    CHUNK_OVERLAP: z.coerce.number().int().min(0).default(200),

    RETRIEVAL_TOP_K: int(5),
    RETRIEVAL_NUM_CANDIDATES: int(100),
    RETRIEVAL_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.55),
    MAX_CONTEXT_CHARS: int(12_000),
    MAX_OUTPUT_TOKENS: int(800),
    MAX_QUESTION_CHARS: int(1000),
    // Conversation memory: how much recent chat the client may send per question.
    HISTORY_MAX_MESSAGES: int(6),
    HISTORY_MAX_CHARS: int(6000),

    // Abuse + cost protection (Phase 5)
    TRUST_PROXY: z.preprocess((v) => v === 'true' || v === '1', z.boolean()).default(false),
    UPLOADS_PER_HOUR: int(20),
    QUESTIONS_PER_10_MIN: int(60),
    DAILY_CHAT_TOKEN_BUDGET: int(500_000),
    DAILY_EMBEDDING_TOKEN_BUDGET: int(5_000_000),
  })
  .refine((env) => env.CHUNK_OVERLAP < env.CHUNK_SIZE, {
    message: 'CHUNK_OVERLAP must be smaller than CHUNK_SIZE',
    path: ['CHUNK_OVERLAP'],
  })
  .refine((env) => env.RETRIEVAL_NUM_CANDIDATES >= env.RETRIEVAL_TOP_K, {
    message: 'RETRIEVAL_NUM_CANDIDATES must be >= RETRIEVAL_TOP_K',
    path: ['RETRIEVAL_NUM_CANDIDATES'],
  });

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  console.error('Copy server/.env.example to server/.env and fill in the values.');
  process.exit(1);
}

export const config = Object.freeze(parsed.data);
