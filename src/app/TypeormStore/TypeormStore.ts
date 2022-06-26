/*!
 * Connect - TypeORM
 * Copyright(c) 2012 TJ Holowaychuk <tj@vision-media.ca>
 * Copyright(c) 2017, 2018 makepost <makepost@firemail.cc>
 * Copyright(c) 2018 Nathan Phillip Brink <ohnobinki@ohnopublishing.net>
 * Copyright(c) 2022 Krzysztof Rosinski <krzysiek@transmissiondynamics.pl>
 * MIT Licensed
 */

import * as Debug from "debug";
import { SessionData, Store } from "express-session";
import { IsNull, Repository } from "typeorm";
import { ISession } from "../../domain/Session/ISession";

/**
 * One day in seconds.
 */
const oneDay = 86400;

export type Ttl =
  | number
  | ((store: TypeormStore, sess: SessionData, sid?: string) => number);

interface ITypeormStoreOptions {
  cleanupLimit: number;
  limitSubquery: boolean;
  onError: (s: TypeormStore, e: Error) => void;
  ttl: Ttl;
}

export class TypeormStore extends Store {
  private cleanupLimit: number | undefined;
  private debug = Debug("connect:typeorm");
  private limitSubquery = true;
  private onError: ((s: TypeormStore, e: Error) => void) | undefined;
  private repository!: Repository<ISession>;
  private ttl: Ttl | undefined;

  /**
   * Initializes TypeormStore with the given `options`.
   */
  constructor(options: Partial<ITypeormStoreOptions> = {}) {
    super();
    this.cleanupLimit = options.cleanupLimit;
    if (options.limitSubquery !== undefined) {
      this.limitSubquery = options.limitSubquery;
    }
    this.onError = options.onError;
    this.ttl = options.ttl;
  }

  public connect(repository: Repository<ISession>) {
    this.repository = repository;
    this.emit("connect");
    return this;
  }

  /**
   * Attempts to fetch session by the given `sid`.
   */
  public get(sid: string, callback: (err?: any, result?: SessionData) => void) {
    (async () => {
      try {
        this.debug('GET "%s"', sid);

        const session = await this.createQueryBuilder()
          .andWhere("session.id = :id", { id: sid })
          .getOne();

        if (!session) { return callback(); }

        this.debug("GOT %s", session.json);

        const result: SessionData = JSON.parse(session.json);
        callback(undefined, result);
      } catch (e) {
        const err = e as Error;
        callback(err);
        this.handleError(err);
      }
    })();
  }

  /**
   * Commits the given `sess` object associated with the given `sid`.
   */
  public set(sid: string, session: SessionData, callback?: (err?: any) => void) {
    (async () => {
      try {
        const args = [sid];
        let json: string;

        try {
          json = JSON.stringify(session);
        } catch (er) {
          return callback ? callback(er) : undefined;
        }

        args.push(json);

        const ttl = this.getTTL(session, sid);
        args.push("EX", ttl.toString());
        this.debug('SET "%s" %s ttl:%s', sid, json, ttl);

        if (this.cleanupLimit) {
          const $ = this.repository
            .createQueryBuilder("session")
            .withDeleted()
            .select("session.id")
            .where(`session.expiredAt <= ${Date.now()}`)
            .limit(this.cleanupLimit);

          let ids = "NULL";
          if (this.limitSubquery) {
            ids = $.getQuery();
          } else {
            const xs = await $.getMany();

            if (xs.length > 0) {
              ids = xs.map((x) => {
                if (typeof x.id === "string") {
                  return `'${x.id
                    .replace(/\\/g, "\\\\")
                    .replace(/'/g, "\\'")}'`;
                } else {
                  return `${x.id}`;
                }
              }).join(", ");
            }
          }

          await this.repository
            .createQueryBuilder()
            .delete()
            .where(`id IN (${ids})`)
            .execute();
        }

        try {
          await this.repository.findOneOrFail({where: { id: sid },  withDeleted: true });
          await this.repository.update({
            destroyedAt: IsNull(),
            id: sid,
          }, {
            expiredAt: Date.now() + ttl * 1000,
            json,
          });
        } catch (_) {
          await this.repository.insert({
            expiredAt: Date.now() + ttl * 1000,
            id: sid,
            json,
          });
        }

        this.debug("SET complete");

        if (callback) {
          callback();
        }
      } catch (e) {
        const err = e as Error;
        if (callback) {
          callback(err);
        }
        this.handleError(err);
      }

    })();
  }

  /**
   * Destroys the session associated with the given `sid`.
   */
  public destroy(sid: string | string[], callback?: (err?: any) => void) {
    (async () => {
      try {
        this.debug('DEL "%s"', sid);

        const sids = Array.isArray(sid) ? sid : [sid];
        const softDelete = sids.map((x) => this.repository.softDelete({ id: x }));
        await Promise.all(softDelete);

        if (callback) {
          callback();
        }
      } catch (e) {
        const err = e as Error;
        if (callback) {
          callback(err);
        }
        this.handleError(err);
      }
    })();
  }

  /**
   * Refreshes the time-to-live for the session with the given `sid`.
   */
  public touch(sid: string, session: SessionData, callback?: (err?: any) => void) {
    (async () => {
      try {
        const ttl = this.getTTL(session);
        this.debug('EXPIRE "%s" ttl:%s', sid, ttl);

        await this.repository
          .createQueryBuilder()
          .update({ expiredAt: Date.now() + ttl * 1000 })
          .whereInIds([sid])
          .execute();

        this.debug("EXPIRE complete");
        if (callback) {
          callback();
        }
      } catch (e) {
        const err = e as Error;
        if (callback) {
          callback(err);
        }
        this.handleError(err);
      }
    })();
  }

  /**
   * Fetches all sessions.
   */
  public all(callback: (err: any, result: (SessionData & { id: string })[]) => void) {
    (async () => {
      try {
        const sessions = await this.createQueryBuilder()
          .getMany();

        const result = sessions.map((session) => {
          const sessionData: SessionData = JSON.parse(session.json);
          return { id: session.id, ...sessionData };
        });

        callback(undefined, result);
      } catch (e) {
        const err = e as Error;
        callback(err, []);
        this.handleError(err);
      }
    })();
  }

  private createQueryBuilder() {
    return this.repository.createQueryBuilder("session")
      .where("session.expiredAt > :expiredAt", { expiredAt: Date.now() });
  }

  private getTTL(sess: SessionData, sid?: string) {
    if (typeof this.ttl === "number") { return this.ttl; }
    if (typeof this.ttl === "function") { return this.ttl(this, sess, sid); }

    const maxAge = sess.cookie.maxAge;
    return (typeof maxAge === "number"
      ? Math.floor(maxAge / 1000)
      : oneDay);
  }

  private handleError(er: Error) {
    this.debug("Typeorm returned err", er);
    if (this.onError) {
      this.onError(this, er);
    } else {
      this.emit("disconnect", er);
    }
  }
}
