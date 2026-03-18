import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsDateString, IsInt, Min } from 'class-validator';

export class CreateFlashSaleDto {
  @ApiProperty({ example: 'Limited Edition Sneakers' })
  @IsString()
  productName: string;

  @ApiProperty({ example: '2026-03-18T10:00:00.000Z' })
  @IsDateString()
  startTime: string;

  @ApiProperty({ example: '2026-03-18T12:00:00.000Z' })
  @IsDateString()
  endTime: string;

  @ApiProperty({ example: 100 })
  @IsInt()
  @Min(1)
  totalInventory: number;
}
