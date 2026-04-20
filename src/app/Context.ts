const _map: Map<string, unknown> = new Map();

export const provide = <T>(key: string, value: T): T => {
	_map.set(key, value);
	return value;
};

export const inject = <T>(key: string): T | undefined => {
	const result = _map.get(key) as T;
	if (result === undefined) console.warn(`Cannot find key ${key}`);

	return result;
};

export class Context {
	private _map: Map<string, unknown> = new Map();
	private parent?: Context;

	provide<T>(key: string, value: T): T {
		// if (this._map.has(key)) {
		// 	throw new Error(
		// 		"You cannot re-provide an already provided key-value pair!!!",
		// 	);
		// }

		this._map.set(key, value);
		return value;
	}

	consume<T>(key: string): T | undefined {
		return this._map.get(key) as T ?? this.parent?.consume(key);
	}

	hook(context: Context) {
		this.parent = context;
	}
}

export class ScopedClass {
	context = new Context();

	hook(context: Context) {
		this.context.hook(context);
		return this;
	}
}