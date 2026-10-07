import { writeFileSync } from 'node:fs';
import { normalizedJsonSchema } from '../src/schema/normalized.js';

writeFileSync(new URL('../schemas/trace-reader-2-draft.1.schema.json', import.meta.url),
  `${JSON.stringify(normalizedJsonSchema(), null, 2)}\n`);
