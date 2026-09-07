import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './config/prisma.module';
import { RedisModule } from './config/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { ProductsModule } from './modules/products/products.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { CartModule } from './modules/cart/cart.module';
import { WishlistModule } from './modules/wishlist/wishlist.module';
import { RecentlyViewedModule } from './modules/recently-viewed/recently-viewed.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { AddressesModule } from './modules/addresses/addresses.module';
import { LocationsModule } from './modules/locations/locations.module';
import { ShippingModule } from './modules/shipping/shipping.module';
import { InternalModule } from './modules/internal/internal.module';
import { VouchersModule } from './modules/vouchers/vouchers.module';
import { BannersModule } from './modules/banners/banners.module';
import { PopupsModule } from './modules/popups/popups.module';
import { FlashSalesModule } from './modules/flash-sales/flash-sales.module';
import { BlogPostsModule } from './modules/blog-posts/blog-posts.module';
import { UploadModule } from './modules/upload/upload.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
      },
    }),
    PrismaModule,
    RedisModule,
    AuthModule,
    UsersModule,
    ProductsModule,
    CategoriesModule,
    CartModule,
    WishlistModule,
    RecentlyViewedModule,
    OrdersModule,
    PaymentsModule,
    AddressesModule,
    LocationsModule,
    ShippingModule,
    InternalModule,
    VouchersModule,
    BannersModule,
    PopupsModule,
    FlashSalesModule,
    BlogPostsModule,
    UploadModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
