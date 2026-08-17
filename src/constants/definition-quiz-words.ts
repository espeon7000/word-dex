// Hardcoded distractor pool for the learn page's multiple-choice definition
// quiz (see app/learn.tsx's buildQuizOptions) - 100 words with a single,
// concise definition each, written in the same plain-sentence style a real
// dictionary API entry would use. These are never quizzed on directly; they
// only ever supply the 3 wrong answers alongside a word actually in the
// user's collection. Deliberately spread across a broad range of meanings
// (not clustered into one theme) so distractors read as plausible-but-wrong
// rather than obviously unrelated.
export type DefinitionQuizWord = {
  word: string;
  definition: string;
};

export const DEFINITION_QUIZ_WORDS: DefinitionQuizWord[] = [
  { word: "ephemeral", definition: "lasting for a very short time." },
  { word: "ubiquitous", definition: "present, appearing, or found everywhere." },
  { word: "cacophony", definition: "a harsh, discordant mixture of sounds." },
  {
    word: "serendipity",
    definition:
      "the occurrence of events by chance in a happy or beneficial way.",
  },
  { word: "mellifluous", definition: "sweet or musical; pleasant to hear." },
  {
    word: "obfuscate",
    definition: "to make something unclear or difficult to understand.",
  },
  { word: "pragmatic", definition: "dealing with things sensibly and realistically." },
  { word: "gregarious", definition: "fond of the company of others; sociable." },
  { word: "austere", definition: "severe or strict in manner or attitude." },
  { word: "laconic", definition: "using very few words." },
  {
    word: "resilient",
    definition: "able to withstand or recover quickly from difficult conditions.",
  },
  {
    word: "ambivalent",
    definition: "having mixed feelings or contradictory ideas about something.",
  },
  { word: "candid", definition: "truthful and straightforward; frank." },
  { word: "deft", definition: "neatly skillful and quick in one's movements." },
  { word: "eloquent", definition: "fluent or persuasive in speaking or writing." },
  { word: "frugal", definition: "sparing or economical with money or food." },
  { word: "hapless", definition: "unfortunate; luckless." },
  {
    word: "impetuous",
    definition: "acting or done quickly and without thought.",
  },
  {
    word: "juxtapose",
    definition: "to place two things side by side for contrasting effect.",
  },
  { word: "lucid", definition: "expressed clearly; easy to understand." },
  {
    word: "meticulous",
    definition: "showing great attention to detail; very careful.",
  },
  { word: "nebulous", definition: "unclear, vague, or ill-defined." },
  {
    word: "obstinate",
    definition: "stubbornly refusing to change one's opinion or course of action.",
  },
  { word: "placate", definition: "to make someone less angry or hostile." },
  {
    word: "quandary",
    definition: "a state of uncertainty or perplexity over what to do.",
  },
  { word: "rancor", definition: "bitterness or resentfulness." },
  {
    word: "sanguine",
    definition: "optimistic or positive, especially in a difficult situation.",
  },
  {
    word: "tenacious",
    definition: "persistent and determined; not readily giving up.",
  },
  { word: "unassuming", definition: "not pretentious or arrogant; modest." },
  { word: "vindicate", definition: "to clear someone of blame or suspicion." },
  {
    word: "wistful",
    definition: "having or showing a feeling of vague or regretful longing.",
  },
  {
    word: "zealous",
    definition: "having or showing great energy or enthusiasm for a cause.",
  },
  { word: "abate", definition: "to become less intense or widespread." },
  { word: "benevolent", definition: "well meaning and kindly." },
  {
    word: "capricious",
    definition: "given to sudden and unaccountable changes of mood or behavior.",
  },
  { word: "dexterous", definition: "skillful with one's hands or body." },
  {
    word: "enervate",
    definition: "to cause someone to feel drained of energy.",
  },
  {
    word: "fastidious",
    definition: "very attentive to and concerned about accuracy and detail.",
  },
  {
    word: "garrulous",
    definition: "excessively talkative, especially about trivial matters.",
  },
  { word: "haughty", definition: "arrogantly superior and disdainful." },
  { word: "imminent", definition: "about to happen very soon." },
  {
    word: "jubilant",
    definition: "feeling or expressing great happiness and triumph.",
  },
  { word: "kindle", definition: "to arouse or inspire a feeling or emotion." },
  {
    word: "languid",
    definition: "displaying or having a disinclination for physical exertion or effort.",
  },
  {
    word: "malleable",
    definition: "easily influenced or changed; capable of being shaped.",
  },
  {
    word: "novice",
    definition: "a person new to and inexperienced in a job or situation.",
  },
  { word: "opulent", definition: "luxurious and expensive-looking." },
  {
    word: "paradox",
    definition: "a statement that seems contradictory but may actually be true.",
  },
  { word: "quaint", definition: "attractively unusual or old-fashioned." },
  {
    word: "reticent",
    definition: "not revealing one's thoughts or feelings readily.",
  },
  { word: "staid", definition: "sedate, respectable, and unadventurous." },
  {
    word: "taciturn",
    definition: "reserved or uncommunicative in speech; saying little.",
  },
  {
    word: "usurp",
    definition: "to take a position of power illegally or by force.",
  },
  {
    word: "venerable",
    definition:
      "accorded a great deal of respect, especially because of age or wisdom.",
  },
  {
    word: "whimsical",
    definition: "playfully quaint or fanciful, especially in an appealing way.",
  },
  {
    word: "yield",
    definition: "to produce or provide something, or to give way to pressure.",
  },
  {
    word: "zenith",
    definition: "the time at which something is most powerful or successful.",
  },
  { word: "adroit", definition: "clever or skillful in using the hands or mind." },
  { word: "bolster", definition: "to support or strengthen." },
  {
    word: "conundrum",
    definition: "a confusing and difficult problem or question.",
  },
  {
    word: "debacle",
    definition: "a sudden and ignominious failure; a fiasco.",
  },
  { word: "effervescent", definition: "vivacious and enthusiastic." },
  {
    word: "flamboyant",
    definition: "tending to attract attention because of confidence and stylishness.",
  },
  {
    word: "gullible",
    definition: "easily persuaded to believe something; credulous.",
  },
  {
    word: "harbinger",
    definition: "a person or thing that announces or signals the approach of another.",
  },
  { word: "incessant", definition: "continuing without pause or interruption." },
  {
    word: "jaded",
    definition: "tired, bored, or lacking enthusiasm after having too much of something.",
  },
  { word: "keen", definition: "having or showing eagerness or enthusiasm." },
  {
    word: "lament",
    definition: "to express passionate grief or sorrow about something.",
  },
  { word: "myriad", definition: "a very large number of something." },
  {
    word: "nonchalant",
    definition: "feeling or appearing casually calm and relaxed.",
  },
  {
    word: "ominous",
    definition: "giving the impression that something bad is going to happen.",
  },
  {
    word: "perfunctory",
    definition: "carried out with minimum effort or reflection.",
  },
  {
    word: "quell",
    definition: "to put an end to a rebellion or violent situation.",
  },
  { word: "ravenous", definition: "extremely hungry." },
  {
    word: "stoic",
    definition: "a person who can endure pain or hardship without showing feelings.",
  },
  {
    word: "tumultuous",
    definition: "marked by loud confusion, disorder, or upheaval.",
  },
  { word: "unfettered", definition: "not restrained or restricted." },
  { word: "vociferous", definition: "vehement or clamorous; loud and forceful." },
  {
    word: "wary",
    definition: "feeling or showing caution about possible dangers or problems.",
  },
  {
    word: "abstain",
    definition: "to restrain oneself from doing or enjoying something.",
  },
  { word: "brazen", definition: "bold and without shame." },
  {
    word: "clairvoyant",
    definition: "having the ability to perceive events or things beyond normal sensory contact.",
  },
  { word: "defer", definition: "to put off or delay an action to a later time." },
  {
    word: "exemplary",
    definition: "serving as a desirable model; representing the best of its kind.",
  },
  {
    word: "fickle",
    definition: "changing frequently, especially regarding loyalties or affections.",
  },
  { word: "gratuitous", definition: "uncalled for; lacking good reason." },
  { word: "hindrance", definition: "a thing that impedes or delays progress." },
  { word: "inept", definition: "having or showing no skill; clumsy." },
  {
    word: "jocular",
    definition: "fond of or characterized by joking; humorous or playful.",
  },
  { word: "knack", definition: "an acquired or natural skill at performing a task." },
  {
    word: "lethargic",
    definition: "affected by lethargy; sluggish and lacking energy.",
  },
  {
    word: "muted",
    definition: "restrained, understated, or having a reduced volume.",
  },
  {
    word: "onerous",
    definition: "involving a great deal of effort, trouble, or difficulty.",
  },
  { word: "plausible", definition: "seeming reasonable or probable." },
  {
    word: "reprehensible",
    definition: "deserving of censure or condemnation.",
  },
  { word: "staunch", definition: "very loyal and committed in attitude." },
  { word: "transient", definition: "lasting only for a short time; passing." },
  {
    word: "unwitting",
    definition: "not aware of the full facts; unintentional.",
  },
  { word: "vivacious", definition: "attractively lively and animated." },
];
