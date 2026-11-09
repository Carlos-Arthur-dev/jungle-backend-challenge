import Decimal from 'decimal.js';

export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

// Isolated constructor: other modules cannot change our arithmetic precision.
const ExactDecimal = Decimal.clone({ precision: 40 });
const MAX_AMOUNT = new ExactDecimal('999999999999999999.99');

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !/^\d+\.\d{2}$/.test(props.amount)) {
      throw new Error('INVALID_MONEY_AMOUNT');
    }
    if (typeof props.currency !== 'string' || !/^[A-Z]{3}$/.test(props.currency)) {
      throw new Error('INVALID_CURRENCY');
    }
    return Money.checked(new ExactDecimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.checked(this.value.add(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.checked(this.value.sub(other.value), this.currency);
  }

  negate(): Money { return Money.checked(this.value.negated(), this.currency); }
  isZero(): boolean { return this.value.isZero(); }
  isPositive(): boolean { return this.value.gt(0); }
  isNegative(): boolean { return this.value.lt(0); }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lt(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.eq(other.value);
  }

  toJSON(): MoneyProps { return { amount: this.toString(), currency: this.currency }; }
  toString(): string { return this.value.toFixed(2); }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new Error('CURRENCY_MISMATCH');
  }

  private static checked(value: Decimal, currency: string): Money {
    if (value.abs().gt(MAX_AMOUNT)) throw new Error('MONEY_OUT_OF_RANGE');
    return new Money(value, currency);
  }
}
