// GET /api/details?id=<detailPath>

import { serve } from "../lib/vercel.js";
import { run } from "../lib/details.js";

export default serve(run);
