import { Money } from './money';
import type { LedgerDirection } from './wallet-ledger-entry';

export type WagerKind = 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type WagerStatus = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
export type FailureCode = 'INSUFFICIENT_FUNDS' | 'REVERSAL_INSUFFICIENT_FUNDS'
  | 'REFERENCE_NOT_FOUND' | 'REFERENCE_REJECTED' | 'REFERENCE_MISMATCH'
  | 'INVALID_REFERENCE_KIND' | 'REVERSAL_AMOUNT_MISMATCH' | 'ALREADY_REVERSED'
  | 'WALLET_NOT_FOUND' | 'PLAYER_MISMATCH' | 'CURRENCY_MISMATCH' | 'INFRASTRUCTURE_FAILURE' | 'BALANCE_LIMIT_EXCEEDED';
export interface WagerProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly createdAt: Date;
}
export interface WagerState extends WagerProps {
  readonly status: WagerStatus;
  readonly referenceTransactionId?: string;
  readonly failureCode?: FailureCode;
  readonly processedAt?: Date;
}
export class WagerTransaction {
  private state: WagerState;
  private constructor(state: WagerState) {
    this.state = { ...state, createdAt: new Date(state.createdAt),
      ...(state.processedAt ? { processedAt: new Date(state.processedAt) } : {}) };
  }
  static create(props: WagerProps): WagerTransaction {
    if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(props.kind)) throw new Error('INVALID_WAGER_KIND');
    if (props.money.isNegative() || (props.kind !== 'LOSS' && !props.money.isPositive())) throw new Error('INVALID_WAGER_AMOUNT');
    if (['REFUND', 'ROLLBACK'].includes(props.kind) && !props.referenceExternalTransactionId?.trim()) throw new Error('REFERENCE_REQUIRED');
    return new WagerTransaction({ ...props, status: 'PENDING' });
  }
  static rehydrate(state: WagerState): WagerTransaction { return new WagerTransaction(state); }
  get id(): string { return this.state.id; }
  get kind(): WagerKind { return this.state.kind; }
  get money(): Money { return this.state.money; }
  get status(): WagerStatus { return this.state.status; }
  get referenceTransactionId(): string | undefined { return this.state.referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this.state.failureCode; }
  get processedAt(): Date | undefined { return this.state.processedAt ? new Date(this.state.processedAt) : undefined; }
  isTerminal(): boolean { return ['PROCESSED', 'REJECTED', 'FAILED'].includes(this.status); }
  affectsBalance(): boolean { return this.kind !== 'LOSS'; }
  requiresReference(): boolean { return this.kind === 'REFUND' || this.kind === 'ROLLBACK'; }
  matchesPayload(hash: string): boolean { return this.state.payloadHash === hash; }
  markPendingReference(): void {
    this.assertMutable();
    if (!this.state.referenceExternalTransactionId) throw new Error('REFERENCE_REQUIRED');
    this.state = { ...this.state, status: 'PENDING_REFERENCE' };
  }
  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertMutable();
    if (this.requiresReference() && !referenceTransactionId) throw new Error('REFERENCE_REQUIRED');
    this.state = { ...this.state, status: 'PROCESSED', processedAt: new Date(at),
      ...(referenceTransactionId ? { referenceTransactionId } : {}) };
  }
  resumeReference():void{
    this.assertMutable();
    if(this.status!=='PENDING_REFERENCE')throw new Error('INVALID_TRANSACTION_STATE');
    this.state={...this.state,status:'PENDING'};
  }
  reject(code: FailureCode): void { this.assertMutable(); this.state = { ...this.state, status: 'REJECTED', failureCode: code }; }
  fail(code: FailureCode): void { this.assertMutable(); this.state = { ...this.state, status: 'FAILED', failureCode: code }; }
  validateReference(reference: WagerTransaction): FailureCode | undefined {
    const a = this.state, b = reference.state;
    if (a.providerId !== b.providerId || a.referenceExternalTransactionId !== b.externalTransactionId
      || a.playerId !== b.playerId || a.walletId !== b.walletId || a.roundId !== b.roundId
      || a.money.currency !== b.money.currency) return 'REFERENCE_MISMATCH';
    if ((a.kind === 'REFUND' && b.kind !== 'BET')
      || (a.kind === 'ROLLBACK' && !['BET', 'WIN', 'REFUND'].includes(b.kind))
      || (['WIN', 'LOSS'].includes(a.kind) && b.kind !== 'BET')) return 'INVALID_REFERENCE_KIND';
    if (reference.isTerminal() && reference.status !== 'PROCESSED') return 'REFERENCE_REJECTED';
    if (this.requiresReference() && !a.money.equals(b.money)) return 'REVERSAL_AMOUNT_MISMATCH';
    return undefined;
  }
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (this.kind === 'LOSS') throw new Error('NO_LEDGER_FOR_LOSS');
    if (this.kind === 'ROLLBACK') {
      if (!reference || this.validateReference(reference) || reference.status !== 'PROCESSED') throw new Error('INVALID_REFERENCE');
      return reference.kind === 'BET' ? 'CREDIT' : 'DEBIT';
    }
    return this.kind === 'BET' ? 'DEBIT' : 'CREDIT';
  }
  private assertMutable(): void { if (this.isTerminal()) throw new Error('INVALID_TRANSACTION_STATE'); }
}
