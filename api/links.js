// GET /api/links?id=<detailPath>&season=1&episode=1

import { serve } from "../lib/vercel.js";
import { run } from "../lib/links.js";

export default serve(run);
