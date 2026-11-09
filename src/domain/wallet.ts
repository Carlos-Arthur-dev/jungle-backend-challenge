import { Money } from './money';
import { WalletLedgerEntry, type LedgerDirection } from './wallet-ledger-entry';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export interface Movement {
  readonly entryId: string;
  readonly transactionId: string;
  readonly money: Money;
  readonly at: Date;
}

export class Wallet {
  private state: WalletState;
  private constructor(state: WalletState) {
    this.state = { ...state, createdAt: new Date(state.createdAt), updatedAt: new Date(state.updatedAt) };
  }
  static open(props: { id: string; playerId: string; initialBalance: Money; at: Date }): Wallet {
    if (props.initialBalance.isNegative()) throw new Error('NEGATIVE_BALANCE');
    return new Wallet({ id: props.id, playerId: props.playerId, currency: props.initialBalance.currency,
      balance: props.initialBalance, version: 1, createdAt: props.at, updatedAt: props.at });
  }
  static rehydrate(state: WalletState): Wallet { return new Wallet(state); }
  get id(): string { return this.state.id; }
  get playerId(): string { return this.state.playerId; }
  get currency(): string { return this.state.currency; }
  get balance(): Money { return this.state.balance; }
  get version(): number { return this.state.version; }
  get createdAt(): Date { return new Date(this.state.createdAt); }
  get updatedAt(): Date { return new Date(this.state.updatedAt); }
  debit(movement: Movement): WalletLedgerEntry { return this.move('DEBIT', movement); }
  credit(movement: Movement): WalletLedgerEntry { return this.move('CREDIT', movement); }
  private move(direction: LedgerDirection, movement: Movement): WalletLedgerEntry {
    if (movement.money.currency !== this.currency) throw new Error('CURRENCY_MISMATCH');
    if (!movement.money.isPositive()) throw new Error('INVALID_MOVEMENT_AMOUNT');
    if (direction === 'DEBIT' && this.balance.isLessThan(movement.money)) throw new Error('INSUFFICIENT_FUNDS');
    const balanceAfter = direction === 'CREDIT'
      ? this.balance.add(movement.money) : this.balance.subtract(movement.money);
    const entry = WalletLedgerEntry.create({ id: movement.entryId, walletId: this.id,
      transactionId: movement.transactionId, direction, money: movement.money,
      balanceBefore: this.balance, balanceAfter, createdAt: movement.at });
    this.state = { ...this.state, balance: balanceAfter, version: this.version + 1, updatedAt: new Date(movement.at) };
    return entry;
  }
}
