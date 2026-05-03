import { DisposableStack } from '@esfx/disposable';

type ContextKey = string;
export type Remover = () => void;

type Entry<T = unknown> = {
	value: T;
	token: symbol;
};

const _map: Map<ContextKey, Entry> = new Map();

function createRemover(
	map: Map<ContextKey, Entry>,
	key: ContextKey,
	token: symbol
): Remover {
	let targetMap: Map<ContextKey, Entry> | undefined = map;
	let targetKey: ContextKey | undefined = key;
	let targetToken: symbol | undefined = token;

	return () => {
		if (!targetMap || targetKey === undefined || targetToken === undefined) {
			return;
		}

		const entry = targetMap.get(targetKey);

		// Prevent old removers from deleting newer values.
		if (entry?.token === targetToken) {
			targetMap.delete(targetKey);
		}

		// Release captured references.
		targetMap = undefined;
		targetKey = undefined;
		targetToken = undefined;
	};
}

export const provide = <T = any>(key: string, value: T): T => {
	_map.set(key, {
		value,
		token: Symbol(key)
	});

	return value;
};

export const inject = <T>(key: string): T | undefined => {
	const entry = _map.get(key);

	if (!entry) {
		console.warn(`Cannot find key ${key}`);
		return undefined;
	}

	return entry.value as T;
};

export const remove = (key: string): boolean => {
	return _map.delete(key);
};

export const clear = (): void => {
	_map.clear();
};

export class Context {
	private _map: Map<ContextKey, Entry> = new Map();
	private parent?: Context;

	provide<T>(key: string, value: T): T {
		this._map.set(key, {
			value,
			token: Symbol(key)
		});

		return value;
	}

	/**
	 * Same public name, but optional remover mode.
	 *
	 * Existing usage still works:
	 *   context.provide('beatmap', beatmap);
	 *
	 * Leak-safe removable usage:
	 *   const remove = context.provide('beatmap', beatmap, true);
	 */
	provideRemovable<T>(key: string, value: T): Remover {
		const token = Symbol(key);

		this._map.set(key, {
			value,
			token
		});

		return createRemover(this._map, key, token);
	}

	remove(key: string): boolean {
		return this._map.delete(key);
	}

	consume<T>(key: string): T | undefined {
		const entry = this._map.get(key);
		if (entry) return entry.value as T;

		return this.parent?.consume<T>(key);
	}

	hook(context: Context) {
		this.parent = context;
		return this;
	}

	destroy() {
		this._map.clear();
		this.parent = undefined;
	}
}

export class ScopedClass {
	context = new Context();
	lifetime = new DisposableStack();

	hook(context: Context) {
		this.context.hook(context);
		return this;
	}

	destroy() {
		this.context.destroy();
		this.lifetime.dispose();
	}
}