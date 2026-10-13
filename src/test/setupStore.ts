import { __setDefaultStoreForTests } from "@/lib/server/storeContext";

// Tests written before there were several stores run in the Wholesale store. Store-isolation tests clear this
// (so a missing store fails loudly) and pick stores explicitly with runInStore.
__setDefaultStoreForTests("main");
