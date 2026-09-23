// GET /api/episode-matrix?id=<detailPath>&season=1&episode=1

import { serve } from "../lib/vercel.js";
import { run } from "../lib/episode-matrix.js";

export default serve(run);
