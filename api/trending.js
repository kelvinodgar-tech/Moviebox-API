// GET /api/trending?limit=20

import { serve } from "../lib/vercel.js";
import { run } from "../lib/trending.js";

export default serve(run);
