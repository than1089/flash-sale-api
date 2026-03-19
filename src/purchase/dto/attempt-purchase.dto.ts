import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MaxLength, IsEmail } from 'class-validator';

export class AttemptPurchaseDto {
  @ApiProperty({
    description: 'Unique email of the user attempting the purchase',
    example: 'alice@example.com',
  })
  @IsEmail({}, { message: 'Invalid email' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  userEmail: string;

  @ApiProperty({
    description: 'ID of the flash sale to purchase from',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsString()
  @IsNotEmpty()
  flashSaleId: string;
}
