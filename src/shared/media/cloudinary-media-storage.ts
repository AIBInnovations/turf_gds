import type {
  UploadApiOptions,
  UploadApiResponse,
  v2 as Cloudinary,
} from 'cloudinary';

export type MediaResourceType = 'image' | 'video' | 'raw' | 'auto';
export type MediaAccess = 'public' | 'authenticated';

export interface UploadMediaOptions {
  publicId?: string;
  folder?: string;
  resourceType?: MediaResourceType;
  access?: MediaAccess;
  tags?: string[];
}

export interface MediaMetadata {
  publicId: string;
  resourceType: string;
  deliveryType: string;
  format: string | undefined;
  bytes: number;
  width: number | undefined;
  height: number | undefined;
  url: string;
  secureUrl: string;
  version: number;
}

export interface MediaStorage {
  uploadBuffer(
    buffer: Buffer,
    options?: UploadMediaOptions,
  ): Promise<MediaMetadata>;
  delete(
    publicId: string,
    resourceType?: Exclude<MediaResourceType, 'auto'>,
  ): Promise<void>;
}

export class CloudinaryMediaStorage implements MediaStorage {
  public constructor(
    private readonly client: typeof Cloudinary,
    private readonly defaultFolder: string,
  ) {}

  public async uploadBuffer(
    buffer: Buffer,
    options: UploadMediaOptions = {},
  ): Promise<MediaMetadata> {
    const uploadOptions: UploadApiOptions = {
      folder: options.folder ?? this.defaultFolder,
      resource_type: options.resourceType ?? 'auto',
      type: options.access === 'authenticated' ? 'authenticated' : 'upload',
    };

    if (options.publicId) {
      uploadOptions.public_id = options.publicId;
    }

    if (options.tags) {
      uploadOptions.tags = options.tags;
    }

    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const upload = this.client.uploader.upload_stream(
        uploadOptions,
        (error, response) => {
          if (error) {
            reject(error);
            return;
          }

          if (!response) {
            reject(new Error('Cloudinary returned no upload response'));
            return;
          }

          resolve(response);
        },
      );

      upload.end(buffer);
    });

    return {
      publicId: result.public_id,
      resourceType: result.resource_type,
      deliveryType: result.type,
      format: result.format,
      bytes: result.bytes,
      width: result.width,
      height: result.height,
      url: result.url,
      secureUrl: result.secure_url,
      version: result.version,
    };
  }

  public async delete(
    publicId: string,
    resourceType: Exclude<MediaResourceType, 'auto'> = 'image',
  ): Promise<void> {
    await this.client.uploader.destroy(publicId, {
      resource_type: resourceType,
      invalidate: true,
    });
  }
}
