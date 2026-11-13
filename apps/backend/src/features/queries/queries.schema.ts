import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type { ScrapingPlan, RedditReport } from '../llm/llm.types';
import type { RedditPost } from '../decodo/decodo.types';
import type { CollectionOutcome } from '../tracker/collection-outcome.types';

export type QueryDocument = HydratedDocument<Query>;

@Schema({ timestamps: true })
export class Query {
  @Prop({ required: true })
  prompt: string;

  @Prop({ type: Object, required: true })
  plan: ScrapingPlan;

  @Prop({ type: Array, default: [] })
  posts: RedditPost[];

  @Prop({ type: Object, required: true })
  report: RedditReport;

  // Per-query collection outcome (success/failure, post counts) plus roll-up
  // totals, persisted alongside the report so history detail can show exactly
  // which searches contributed — or failed to contribute — to the conclusions.
  @Prop({ type: Object, required: true })
  collectionOutcome: CollectionOutcome;
}

export const QuerySchema = SchemaFactory.createForClass(Query);
