declare module "sentiment" {
  export default class Sentiment {
    analyze(text: string): { comparative: number };
  }
}

declare module "vader-sentiment" {
  const vader: {
    SentimentIntensityAnalyzer: {
      polarity_scores(text: string): { compound: number };
    };
  };
  export default vader;
}
