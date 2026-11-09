import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('soma sem perder centavos e preserva a instância original', () => {
    const original = brl('0.10');
    expect(original.add(brl('0.20')).toString()).toBe('0.30');
    expect(original.toString()).toBe('0.10');
  });

  test('preserva valores que ultrapassam a precisão de number', () => {
    expect(brl('9007199254740993.01').add(brl('0.01')).toString())
      .toBe('9007199254740993.02');
  });

  test.each(['', 'NaN', 'Infinity', '1e2', '-1.00', '1.001', '1', '1.0', ' 1.00', '+1.00'])
    ('rejeita entrada inválida: %s', amount => {
      expect(() => brl(amount)).toThrow('INVALID_MONEY_AMOUNT');
    });

  test('rejeita number em tempo de execução', () => {
    expect(() => brl(1 as unknown as string)).toThrow('INVALID_MONEY_AMOUNT');
  });

  test('não arredonda silenciosamente nem permite overflow', () => {
    expect(() => brl('1.005')).toThrow();
    expect(() => brl('999999999999999999.99').add(brl('0.01')))
      .toThrow('MONEY_OUT_OF_RANGE');
  });

  test('operações internas podem produzir diferença negativa', () => {
    const difference = brl('1.00').subtract(brl('2.00'));
    expect(difference.isNegative()).toBe(true);
    expect(difference.negate().equals(brl('1.00'))).toBe(true);
    expect(difference.toJSON()).toEqual({ amount: '-1.00', currency: 'BRL' });
  });

  test('operações entre moedas distintas são erros de domínio', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    for (const operation of ['add', 'subtract', 'equals', 'isLessThan'] as const) {
      expect(() => brl('1.00')[operation](usd)).toThrow('CURRENCY_MISMATCH');
    }
  });

  test('zero, comparação e serialização mantêm escala fixa', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('1.00').isPositive()).toBe(true);
    expect(brl('1.00').isLessThan(brl('2.00'))).toBe(true);
    expect(JSON.stringify(brl('001.00'))).toBe('{"amount":"1.00","currency":"BRL"}');
  });
});
