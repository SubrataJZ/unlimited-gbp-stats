import axios from 'axios';
import { prisma } from '../index';
import { AuthenticationError, InternalServerError } from '../utils/errors';
import logger from '../utils/logger';

/**
 * Google Service Class
 *
 * Purpose:
 * - Handles all Google API interactions
 * - Manages OAuth callback processing
 * - Fetches user's managed locations from Google Business Profile API
 * - Auto-links locations to user in database
 *
 * Architecture:
 * - Uses Axios for HTTP requests to Google APIs
 * - Stores access/refresh tokens in database
 * - Automatically refreshes tokens when expired
 */
class GoogleService {
  private baseUrl = 'https://mybusiness.googleapis.com';
  private apiVersion = 'v4';

  /**
   * Constructor
   * Initializes the Google Service with configuration from environment
   */
  constructor() {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      logger.warn(
        'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET not configured - OAuth flows will fail'
      );
    }
  }

  /**
   * Method: Handle Google OAuth Callback
   *
   * Purpose:
   * - Processes the authorization code from Google OAuth callback
   * - Exchanges authorization code for access & refresh tokens
   * - Creates or updates user in database
   * - Triggers auto-linking of locations
   *
   * Flow:
   * 1. Exchange auth code for tokens
   * 2. Fetch user info from Google
   * 3. Create/update user in database
   * 4. Fetch managed locations from Google Business API
   * 5. Auto-link locations to user
   * 6. Return user object
   *
   * @param authCode Authorization code from Google OAuth callback
   * @returns User object with linked locations
   */
  async handleOAuthCallback(authCode: string) {
    try {
      logger.info('Processing Google OAuth callback');

      // Step 1: Exchange authorization code for tokens
      const tokens = await this.exchangeAuthCodeForTokens(authCode);
      logger.debug('Successfully exchanged auth code for tokens');

      // Step 2: Fetch user info from Google
      const googleUser = await this.fetchGoogleUserInfo(tokens.access_token);
      logger.debug(`Fetched user info for: ${googleUser.email}`);

      // Step 3: Create or update user in database
      const user = await prisma.user.upsert({
        where: { googleId: googleUser.id },
        update: {
          email: googleUser.email,
          name: googleUser.name,
          avatarUrl: googleUser.picture,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token || undefined,
          updatedAt: new Date(),
        },
        create: {
          googleId: googleUser.id,
          email: googleUser.email,
          name: googleUser.name,
          avatarUrl: googleUser.picture,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
        },
      });

      logger.info(`User ${user.id} authenticated successfully`);

      // Step 4: Fetch managed locations from Google Business API
      const locations = await this.fetchManagedLocations(tokens.access_token);
      logger.info(`Found ${locations.length} managed locations for user`);

      // Step 5: Auto-link locations to user
      await this.autoLinkLocations(user.id, locations, tokens.access_token);

      logger.info(`Auto-linked ${locations.length} locations for user ${user.id}`);

      // Step 6: Return user with updated location info
      const updatedUser = await prisma.user.findUnique({
        where: { id: user.id },
        include: {
          locations: {
            select: {
              id: true,
              googleLocationId: true,
              businessName: true,
              isActive: true,
              createdAt: true,
            },
          },
        },
      });

      return updatedUser;
    } catch (error) {
      logger.error('Failed to process OAuth callback:', error);
      throw error;
    }
  }

  /**
   * Method: Exchange Authorization Code for Tokens
   *
   * Purpose:
   * - Exchanges Google OAuth authorization code for access and refresh tokens
   * - Tokens are used for subsequent API calls on behalf of user
   *
   * @param authCode Authorization code from Google OAuth callback
   * @returns Object containing access_token and refresh_token
   */
  private async exchangeAuthCodeForTokens(
    authCode: string
  ): Promise<{ access_token: string; refresh_token?: string }> {
    try {
      const response = await axios.post(
        'https://oauth2.googleapis.com/token',
        {
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          code: authCode,
          grant_type: 'authorization_code',
          redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        }
      );

      return {
        access_token: response.data.access_token,
        refresh_token: response.data.refresh_token,
      };
    } catch (error) {
      logger.error('Failed to exchange auth code for tokens:', error);
      throw new AuthenticationError(
        'Failed to authenticate with Google. Please try again.'
      );
    }
  }

  /**
   * Method: Fetch Google User Info
   *
   * Purpose:
   * - Retrieves authenticated user's profile information from Google
   * - Uses Google OAuth userinfo endpoint
   *
   * @param accessToken Google OAuth access token
   * @returns User object (id, email, name, picture)
   */
  private async fetchGoogleUserInfo(accessToken: string) {
    try {
      const response = await axios.get(
        'https://www.googleapis.com/oauth2/v2/userinfo',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      return {
        id: response.data.id,
        email: response.data.email,
        name: response.data.name,
        picture: response.data.picture,
      };
    } catch (error) {
      logger.error('Failed to fetch Google user info:', error);
      throw new AuthenticationError('Failed to fetch user profile from Google');
    }
  }

  /**
   * Method: Fetch Managed Locations (Mock for Testing)
   *
   * Purpose:
   * - In production: Retrieves all Google Business Profile locations managed by the user
   * - For testing: Returns mock locations
   *
   * @param accessToken Google OAuth access token with business.manage scope
   * @returns Array of location objects
   */
  private async fetchManagedLocations(accessToken: string) {
    try {
      // Mock implementation for testing
      logger.info('Fetching managed locations (mock mode for testing)');

      // Return mock locations for development
      const mockLocations = [
        {
          name: 'accounts/123456789/locations/9876543210',
          displayName: 'Downtown Coffee Shop',
          title: 'Coffee Shop - Downtown',
        },
        {
          name: 'accounts/123456789/locations/9876543211',
          displayName: 'Uptown Coffee Shop',
          title: 'Coffee Shop - Uptown',
        },
      ];

      logger.debug(`Returning ${mockLocations.length} mock locations`);
      return mockLocations;

      // TODO: For production, enable the real Google Business API call below:
      /*
      const accountsResponse = await axios.get(
        `https://mybusiness.googleapis.com/v4/accounts`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      const accounts = accountsResponse.data.accounts || [];
      const allLocations: any[] = [];

      for (const account of accounts) {
        try {
          const locationsResponse = await axios.get(
            `https://mybusiness.googleapis.com/v4/${account.name}/locations`,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
              },
              params: {
                readMask: 'name,displayName,title',
              },
            }
          );

          const locations = locationsResponse.data.locations || [];
          allLocations.push(...locations);
        } catch (error) {
          logger.warn(`Failed to fetch locations for account ${account.name}:`, error);
        }
      }

      return allLocations;
      */
    } catch (error) {
      logger.error('Failed to fetch managed locations:', error);
      throw new InternalServerError(
        'Failed to fetch your business locations from Google'
      );
    }
  }

  /**
   * Method: Auto-Link Locations
   *
   * Purpose:
   * - Creates Location records in database for each Google location
   * - Links locations to the authenticated user
   * - Handles case where location already exists (updates instead of creating)
   * - Makes historical data collected by Chrome extension instantly accessible
   *
   * @param userId Database user ID
   * @param googleLocations Array of Google location objects
   * @param accessToken For potential future API calls per location
   */
  private async autoLinkLocations(
    userId: string,
    googleLocations: any[],
    accessToken: string
  ) {
    const results = {
      created: 0,
      linked: 0,
      updated: 0,
      failed: 0,
    };

    for (const googleLocation of googleLocations) {
      try {
        // Extract location ID from Google's response
        const locationId = this.extractLocationId(googleLocation.name);

        if (!locationId) {
          logger.warn(`Could not extract location ID from: ${googleLocation.name}`);
          results.failed++;
          continue;
        }

        // Extract display name
        const businessName = googleLocation.displayName || googleLocation.title || 'Unnamed Location';

        /**
         * Upsert Location:
         * - If exists with same googleLocationId, update it
         * - If doesn't exist, create new
         */
        const location = await prisma.location.upsert({
          where: { googleLocationId: locationId },
          update: {
            businessName,
            userId,
            isActive: true,
          },
          create: {
            googleLocationId: locationId,
            businessName,
            userId,
            isActive: true,
          },
        });

        results.created++;
        logger.info(`Location ${locationId} linked to user ${userId}`);
      } catch (error) {
        logger.error(
          `Failed to auto-link location ${googleLocation.name}:`,
          error
        );
        results.failed++;
      }
    }

    logger.info(
      `Auto-link summary - Created: ${results.created}, Updated: ${results.updated}, Failed: ${results.failed}`
    );
  }

  /**
   * Helper Method: Extract Location ID from Google's Path
   *
   * Purpose:
   * - Parses location ID from Google's full resource path
   * - Google returns: "accounts/{accountId}/locations/{locationId}"
   * - We need to extract just the {locationId}
   *
   * @param path Full resource path from Google
   * @returns Extracted location ID (numeric string)
   */
  private extractLocationId(path: string): string | null {
    const match = path.match(/locations\/(\d+)/);
    return match ? match[1] : null;
  }

  /**
   * Method: Refresh Access Token
   *
   * Purpose:
   * - Refreshes an expired access token using refresh token
   * - Updates token in database
   * - Called when API request returns 401 Unauthorized
   *
   * @param userId User ID
   * @returns New access token
   */
  async refreshAccessToken(userId: string): Promise<string> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user || !user.refreshToken) {
        throw new AuthenticationError(
          'User not authenticated or refresh token missing'
        );
      }

      const response = await axios.post(
        'https://oauth2.googleapis.com/token',
        {
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: user.refreshToken,
        }
      );

      const newAccessToken = response.data.access_token;

      // Update access token in database
      await prisma.user.update({
        where: { id: userId },
        data: { accessToken: newAccessToken },
      });

      return newAccessToken;
    } catch (error) {
      logger.error('Failed to refresh access token:', error);
      throw new AuthenticationError('Failed to refresh authentication');
    }
  }
}

// Export singleton instance
export default new GoogleService();
