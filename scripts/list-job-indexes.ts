import 'dotenv/config';
import { connectDatabase, disconnectDatabase } from '../src/config/database';
import { Job } from '../src/models/Job';

(async () => {
  try {
    await connectDatabase();
    const idx = await Job.collection.indexes();
    console.log(JSON.stringify(idx, null, 2));
  } finally {
    await disconnectDatabase().catch(() => {});
    process.exit();
  }
})();
