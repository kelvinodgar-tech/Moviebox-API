// GET /api/tv?id=<detailPath>&season=1&episode=1

import { serve } from "../lib/vercel.js";
import { runTv } from "../lib/links.js";

export default serve(runTv);
