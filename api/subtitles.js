// GET /api/subtitles?id=<detailPath>&season=1&episode=1

import { serve } from "../lib/vercel.js";
import { run } from "../lib/subtitles.js";

export default serve(run);
