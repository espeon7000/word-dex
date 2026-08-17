export type SingleDefinition = {
  definition: string;
};

export type Meaning = {
  partOfSpeech: string;
  definitions: SingleDefinition[];
};

export type Entry = {
  word: string;
  phonetic?: string;
  meanings: Meaning[];
};
