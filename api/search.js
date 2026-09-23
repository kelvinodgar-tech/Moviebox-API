// GET /api/search?q=<title>&limit=20&page=1

import { serve } from "../lib/vercel.js";
import { run } from "../lib/search.js";

export default serve(run);
