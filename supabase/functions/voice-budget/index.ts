import { createVoiceBudgetHandler } from "./handler.ts";
Deno.serve(createVoiceBudgetHandler(Deno.env));
