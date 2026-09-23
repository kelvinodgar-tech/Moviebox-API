// GET /api/movie?id=<detailPath>

import { serve } from "../lib/vercel.js";
import { runMovie } from "../lib/links.js";

export default serve(runMovie);
