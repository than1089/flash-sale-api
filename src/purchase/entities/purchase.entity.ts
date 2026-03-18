import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { FlashSale } from '../../flash-sale/entities/flash-sale.entity';

export enum PurchaseStatus {
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
}

@Entity('purchases')
@Index(['userEmail', 'flashSaleId'], { unique: true }) // DB-level guard against duplicates
export class Purchase {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_email' })
  userEmail: string;

  @Column({ name: 'flash_sale_id' })
  flashSaleId: string;

  @ManyToOne(() => FlashSale, { eager: false })
  @JoinColumn({ name: 'flash_sale_id' })
  flashSale: FlashSale;

  @Column({
    type: 'enum',
    enum: PurchaseStatus,
  })
  status: PurchaseStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
