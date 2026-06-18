import type { RunSummary } from '../orchestrator/summary.js';

export type GoalStatus = 'active' | 'succeeded' | 'blocked' | 'failed' | 'stopped';

export type GoalIterationOutcome = 'planned' | 'processed' | 'succeeded' | 'blocked' | 'failed';

export interface GoalNextIssue {
  title: string;
  body: string;
  priority: 'P0' | 'P1' | 'P2';
}

export interface GoalEvaluation {
  status: 'succeeded' | 'continue' | 'blocked' | 'failed';
  confidence: number;
  reason: string;
  satisfiedCriteria: string[];
  missingCriteria: string[];
  nextIssue?: GoalNextIssue;
}

export interface GoalMechanicalEvaluation {
  command: string;
  ok: boolean;
  output: string;
}

export interface GoalIteration {
  number: number;
  startedAt: string;
  finishedAt?: string;
  issue?: number;
  runSummary?: RunSummary;
  outcome: GoalIterationOutcome;
  summary: string;
  mechanicalEvaluation?: GoalMechanicalEvaluation;
  evaluation?: GoalEvaluation;
}

export interface GoalState {
  version: 1;
  id: string;
  project: string;
  title: string;
  description: string;
  successCriteria: string[];
  constraints: string[];
  status: GoalStatus;
  maxIterations: number;
  createdAt: string;
  updatedAt: string;
  stoppedReason?: string;
  finalReason?: string;
  iterations: GoalIteration[];
}

export interface GoalPlan {
  status: 'issue' | 'succeeded' | 'blocked';
  reason: string;
  nextIssue?: GoalNextIssue;
}
