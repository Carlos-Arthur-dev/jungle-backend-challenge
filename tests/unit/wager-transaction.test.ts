import { expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { WagerTransaction, type WagerProps } from '../../src/domain/wager-transaction';
const at = new Date('2026-11-08T12:00:00Z');
function create(overrides: Partial<WagerProps> = {}) {
  return WagerTransaction.create({ id: 'tx', providerId: 'provider', externalTransactionId: 'bet',
    idempotencyKey: 'key', payloadHash: 'hash', walletId: 'wallet', playerId: 'player', roundId: 'round',
    gameId: 'game', kind: 'BET', money: Money.from({ amount: '10.00', currency: 'BRL' }), createdAt: at, ...overrides });
}
test('operações têm direções explícitas e LOSS não gera ledger', () => {
  expect(create().ledgerDirectionFor()).toBe('DEBIT');
  expect(create({ kind: 'WIN' }).ledgerDirectionFor()).toBe('CREDIT');
  expect(create({ kind: 'LOSS' }).affectsBalance()).toBe(false);
  expect(() => create({ kind: 'LOSS' }).ledgerDirectionFor()).toThrow('NO_LEDGER_FOR_LOSS');
  expect(() => create({ kind: 'OPENING' })).toThrow('INVALID_WAGER_KIND');
  expect(() => create({ kind: 'REFUND' })).toThrow('REFERENCE_REQUIRED');
});
test('estados terminais bloqueiam todas as transições', () => {
  for (const status of ['PROCESSED', 'REJECTED', 'FAILED'] as const) {
    const tx = create();
    if (status === 'PROCESSED') tx.markProcessed(undefined, at);
    else if (status === 'REJECTED') tx.reject('INSUFFICIENT_FUNDS');
    else tx.fail('INFRASTRUCTURE_FAILURE');
    expect(() => tx.markProcessed(undefined, at)).toThrow('INVALID_TRANSACTION_STATE');
    expect(() => tx.reject('REFERENCE_NOT_FOUND')).toThrow('INVALID_TRANSACTION_STATE');
    expect(() => tx.fail('INFRASTRUCTURE_FAILURE')).toThrow('INVALID_TRANSACTION_STATE');
    expect(() => tx.markPendingReference()).toThrow('INVALID_TRANSACTION_STATE');
    expect(() => tx.resumeReference()).toThrow('INVALID_TRANSACTION_STATE');
  }
});
test('referência pendente pode ser resolvida e rollback inverte efeito', () => {
  const bet = create(); bet.markProcessed(undefined, at);
  const rollback = create({ kind: 'ROLLBACK', referenceExternalTransactionId: 'bet' });
  rollback.markPendingReference();
  expect(rollback.status).toBe('PENDING_REFERENCE');
  rollback.resumeReference();expect(rollback.status).toBe('PENDING');
  expect(rollback.validateReference(bet)).toBeUndefined();
  expect(rollback.ledgerDirectionFor(bet)).toBe('CREDIT');
  rollback.markProcessed(bet.id, at);
  expect(rollback.referenceTransactionId).toBe(bet.id);
  const win = create({ kind: 'WIN' }); win.markProcessed(undefined, at);
  expect(create({ kind: 'ROLLBACK', referenceExternalTransactionId: 'bet' }).ledgerDirectionFor(win)).toBe('DEBIT');
});
test('valida identidade, espécie e valor da referência; compara hash', () => {
  const refund = create({ kind: 'REFUND', referenceExternalTransactionId: 'bet' });
  expect(refund.validateReference(create({ walletId: 'other' }))).toBe('REFERENCE_MISMATCH');
  expect(refund.validateReference(create({ kind: 'WIN' }))).toBe('INVALID_REFERENCE_KIND');
  expect(refund.validateReference(create({ money: Money.from({ amount: '9.00', currency: 'BRL' }) })))
    .toBe('REVERSAL_AMOUNT_MISMATCH');
  expect(refund.matchesPayload('hash')).toBe(true);
  expect(refund.matchesPayload('different')).toBe(false);
});
