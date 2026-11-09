import { expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-08T12:00:00Z');
const open = () => Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: brl('100.00'), at });
const movement = (amount: string) => ({ entryId: 'entry', transactionId: 'tx', money: brl(amount), at });

test('debita e retorna lançamento consistente; rejeição preserva estado', () => {
  const wallet = open();
  const entry = wallet.debit(movement('80.00'));
  expect(entry.direction).toBe('DEBIT');
  expect(entry.balanceBefore.toString()).toBe('100.00');
  expect(entry.balanceAfter.toString()).toBe('20.00');
  expect(entry.isBalanced()).toBe(true);
  expect(wallet.version).toBe(2);
  expect(() => wallet.debit(movement('80.00'))).toThrow('INSUFFICIENT_FUNDS');
  expect(wallet.balance.toString()).toBe('20.00');
  expect(wallet.version).toBe(2);
});
test('crédito e débito total preservam igualdade com os lançamentos', () => {
  const wallet = open();
  const credit = wallet.credit(movement('25.00'));
  const debit = wallet.debit(movement('125.00'));
  expect(credit.direction).toBe('CREDIT');
  expect(wallet.balance.isZero()).toBe(true);
  expect(wallet.version).toBe(3);
  expect(debit.isBalanced()).toBe(true);
});
test('rejeita moeda diferente, zero e valor negativo sem alterar carteira', () => {
  const wallet = open();
  expect(() => wallet.credit({ ...movement('1.00'), money: Money.zero('USD') })).toThrow('CURRENCY_MISMATCH');
  expect(() => wallet.debit(movement('0.00'))).toThrow('INVALID_MOVEMENT_AMOUNT');
  expect(() => wallet.credit({ ...movement('1.00'), money: brl('1.00').negate() })).toThrow('INVALID_MOVEMENT_AMOUNT');
  expect(wallet.version).toBe(1);
  expect(wallet.balance.toString()).toBe('100.00');
});
test('ledger rejeita aritmética inconsistente e protege datas de mutação externa', () => {
  const entry = open().credit(movement('1.00'));
  entry.createdAt.setFullYear(2000);
  expect(entry.createdAt.getUTCFullYear()).toBe(2026);
  expect(() => WalletLedgerEntry.create({ id: 'e', walletId: 'w', transactionId: 't', direction: 'CREDIT',
    money: brl('1.00'), balanceBefore: brl('0.00'), balanceAfter: brl('2.00'), createdAt: at }))
    .toThrow('UNBALANCED_LEDGER_ENTRY');
});
test('rehydrate restaura versão e datas; abertura rejeita saldo negativo', () => {
  const wallet = Wallet.rehydrate({ id: 'w', playerId: 'p', currency: 'BRL', balance: brl('20.00'),
    version: 8, createdAt: at, updatedAt: at });
  expect(wallet.version).toBe(8);
  wallet.updatedAt.setFullYear(2000);
  expect(wallet.updatedAt.getUTCFullYear()).toBe(2026);
  expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00').negate(), at }))
    .toThrow('NEGATIVE_BALANCE');
});
