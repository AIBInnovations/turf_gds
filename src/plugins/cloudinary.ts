import { v2 as cloudinary } from 'cloudinary';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import type { AppConfig } from '../config/env.js';
import {
  CloudinaryMediaStorage,
  type MediaStorage,
} from '../shared/media/cloudinary-media-storage.js';

declare module 'fastify' {
  interface FastifyInstance {
    mediaStorage: MediaStorage;
  }
}

export interface CloudinaryPluginOptions {
  config: AppConfig['cloudinary'];
  storage?: MediaStorage;
}

const cloudinaryPlugin: FastifyPluginAsync<CloudinaryPluginOptions> = async (
  fastify,
  options,
) => {
  let storage = options.storage;

  if (!storage) {
    cloudinary.config({
      cloud_name: options.config.cloudName,
      api_key: options.config.apiKey,
      api_secret: options.config.apiSecret,
      secure: true,
      hide_sensitive: true,
    });

    storage = new CloudinaryMediaStorage(
      cloudinary,
      options.config.folder,
    );
  }

  fastify.decorate('mediaStorage', storage);
};

export default fp(cloudinaryPlugin, {
  name: 'cloudinary',
  fastify: '5.x',
});
