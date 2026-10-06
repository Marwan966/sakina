import { createQuranSearchHandler } from "./handler.ts";
Deno.serve(createQuranSearchHandler(Deno.env));
