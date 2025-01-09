/* eslint-disable @typescript-eslint/no-unused-vars */
import { debug } from '@sitecore-jss/sitecore-jss';
import { NextRequest, NextResponse } from 'next/server';
import { RedirectsMiddlewareBase } from 'lib/vercel/temp-redirects-middleware-base';
import { RedirectsMiddlewareConfig } from '@sitecore-jss/sitecore-jss-nextjs/middleware';
import { SiteInfo } from '@sitecore-jss/sitecore-jss-nextjs/types/site';
import regexParser from 'regex-parser';
import {
  REDIRECT_TYPE_301,
  REDIRECT_TYPE_302,
  REDIRECT_TYPE_SERVER_TRANSFER,
  RedirectInfo,
} from '@sitecore-jss/sitecore-jss/site';
import { getComputeCache } from './compute-cache';

const REGEXP_CONTEXT_SITE_LANG = new RegExp(/\$siteLang/, 'i');
const REGEXP_ABSOLUTE_URL = new RegExp('^(?:[a-z]+:)?//', 'i');

export class VDCRedirectsMiddleware extends RedirectsMiddlewareBase {
  constructor(config: RedirectsMiddlewareConfig) {
    super(config);
  }

  public getHandler(): (req: NextRequest, res?: NextResponse) => Promise<NextResponse> {
    return async (req, res) => {
      try {
        return await this.cachedHandler(req, res);
      } catch (error) {
        console.log('Redirect middleware failed:');
        console.log(error);
        return res || NextResponse.next();
      }
    };
  }

  private cachedHandler = async (req: NextRequest, res?: NextResponse): Promise<NextResponse> => {
    const pathname = req.nextUrl.pathname;
    const language = this.getLanguage(req);
    const hostname = this.getHostHeader(req) || this.defaultHostname;
    let site: SiteInfo | undefined;
    const startTimestamp = Date.now();

    debug.redirects('redirects middleware start: %o', {
      pathname,
      language,
      hostname,
    });

    const createResponse = async () => {
      if (this.config.disabled && this.config.disabled(req, res || NextResponse.next())) {
        debug.redirects('skipped (redirects middleware is disabled)');
        return res || NextResponse.next();
      }

      if (this.isPreview(req) || this.excludeRoute(pathname)) {
        debug.redirects('skipped (%s)', this.isPreview(req) ? 'preview' : 'route excluded');
        return res || NextResponse.next();
      }

      site = this.getSite(req, res);

      const computeCache = await getComputeCache<
        | (RedirectInfo & {
            matchedQueryString?: string;
          })
        | 'no-redirect'
        | undefined
      >(req.headers);

      // get the redirect from the cache
      let redirect = await computeCache.get(this.getRedirectCacheKey(req, site));

      // if there is a cached no-redirect, skip the redirect
      if (redirect === 'no-redirect') {
        debug.redirects('skipped (no redirect)');
        return res || NextResponse.next();
      }

      // if there is nothing in the cache, get it from Sitecore
      if (!redirect) {
        redirect = await this.getExistsRedirect(req, site.name);
      }

      // if there is no redirect from Sitecore cache it as a no-redirect, otherwise continue with the redirect received
      if (!redirect) {
        debug.redirects('skipped (redirect does not exist)');
        await computeCache.set(this.getRedirectCacheKey(req, site), 'no-redirect');
        return res || NextResponse.next();
      }

      // Find context site language and replace token
      if (
        REGEXP_CONTEXT_SITE_LANG.test(redirect.target) &&
        !(REGEXP_ABSOLUTE_URL.test(redirect.target) && redirect.target.includes(hostname))
      ) {
        redirect.target = redirect.target.replace(REGEXP_CONTEXT_SITE_LANG, site.language);

        req.nextUrl.locale = site.language;
      }

      const url = this.normalizeUrl(req.nextUrl.clone());

      if (REGEXP_ABSOLUTE_URL.test(redirect.target)) {
        url.href = redirect.target;
      } else {
        const source = `${url.pathname.replace(/\/*$/gi, '')}${redirect.matchedQueryString}`;
        const urlFirstPart = redirect.target.split('/')[1];
        if (this.locales.includes(urlFirstPart)) {
          req.nextUrl.locale = urlFirstPart;
          redirect.target = redirect.target.replace(`/${urlFirstPart}`, '');
        }

        const target = source
          .replace(regexParser(redirect.pattern), redirect.target)
          .replace(/^\/\//, '/')
          .split('?');

        if (url.search && redirect.isQueryStringPreserved) {
          const targetQueryString = target[1] ?? '';
          url.search = '?' + new URLSearchParams(`${url.search}&${targetQueryString}`).toString();
        } else if (target[1]) {
          url.search = '?' + target[1];
        } else {
          url.search = '';
        }

        const prepareNewURL = new URL(`${target[0]}${url.search}`, url.origin);

        url.href = prepareNewURL.href;
        url.pathname = prepareNewURL.pathname;
        url.search = prepareNewURL.search;
        url.locale = req.nextUrl.locale;
      }

      /** return Response redirect with http code of redirect type */
      switch (redirect.redirectType) {
        case REDIRECT_TYPE_301: {
          return this.createRedirectResponse(url, res, 301, 'Moved Permanently');
        }
        case REDIRECT_TYPE_302: {
          return this.createRedirectResponse(url, res, 302, 'Found');
        }
        case REDIRECT_TYPE_SERVER_TRANSFER: {
          return this.rewrite(url.href, req, res || NextResponse.next());
        }
        default:
          return res || NextResponse.next();
      }
    };

    const response = await createResponse();

    debug.redirects('redirects middleware end in %dms: %o', Date.now() - startTimestamp, {
      redirected: response.redirected,
      status: response.status,
      url: response.url,
      headers: this.extractDebugHeaders(response.headers),
    });

    return response;
  };

  private getRedirectCacheKey(req: NextRequest, site: SiteInfo): string {
    const { pathname, search = '', locale } = this.normalizeUrl(req.nextUrl.clone());
    return `${pathname}:${search}:${locale}:${site}`;
  }
}
