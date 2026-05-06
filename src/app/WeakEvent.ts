export type Disposer = () => void;

type WeakEventHandler<TTarget extends object, TEvent> = (
	target: TTarget,
	event: TEvent
) => void;

type WeakEventListener<TTarget extends object, TEvent> = {
	ref: WeakRef<TTarget>;
	handler: WeakEventHandler<TTarget, TEvent> | undefined;
	active: boolean;
	disposed: boolean;
	id: number;
	createdAt: number;
	stack?: string;
};

let nextWeakEventListenerId = 1;

export default class WeakEvent<TEvent> {
	private listeners: WeakEventListener<object, TEvent>[] = [];

	private readonly cleanupRegistry =
		new FinalizationRegistry<WeakEventListener<object, TEvent>>((listener) => {
			listener.active = false;
			listener.handler = undefined;
		});

	get activeEstimate(): number {
		return this.listeners.length;
	}

	subscribe<TTarget extends object>(
		target: TTarget,
		handler: WeakEventHandler<TTarget, TEvent>
	): Disposer {
		const listener: WeakEventListener<object, TEvent> = {
			ref: new WeakRef(target),
			handler: handler as WeakEventHandler<object, TEvent>,
			active: true,
			disposed: false,
			id: nextWeakEventListenerId++,
			createdAt: performance.now(),
			stack: this.captureStack()
		};

		this.listeners.push(listener);
		this.cleanupRegistry.register(target, listener, listener);

		let disposed = false;

		return () => {
			if (disposed) return;
			disposed = true;

			listener.disposed = true;
			listener.active = false;
			listener.handler = undefined;

			this.cleanupRegistry.unregister(listener);
		};
	}

	emit(event: TEvent): number {
		const listeners = this.listeners;
		const initialCount = listeners.length;

		let write = 0;
		let invoked = 0;

		for (let read = 0; read < initialCount; read++) {
			const listener = listeners[read];

			if (!listener.active) continue;

			const target = listener.ref.deref();

			if (target === undefined) {
				listener.active = false;
				listener.handler = undefined;
				continue;
			}

			const handler = listener.handler;

			if (handler === undefined) {
				listener.active = false;
				continue;
			}

			handler(target, event);
			invoked++;

			if (listener.active) {
				listeners[write++] = listener;
			}
		}

		// Preserve listeners added during emit().
		for (let i = initialCount; i < listeners.length; i++) {
			listeners[write++] = listeners[i];
		}

		listeners.length = write;

		return invoked;
	}

	clear(): void {
		for (let i = 0; i < this.listeners.length; i++) {
			const listener = this.listeners[i];

			listener.disposed = true;
			listener.active = false;
			listener.handler = undefined;

			this.cleanupRegistry.unregister(listener);
		}

		this.listeners.length = 0;
	}

	private captureStack(): string | undefined {
		const stack = new Error().stack;
		if (!stack) return undefined;

		return stack
			.split('\n')
			.slice(3)
			.join('\n');
	}
}