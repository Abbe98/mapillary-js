/// <reference path="../../../typings/index.d.ts" />

import * as THREE from "three";

import {Observable} from "rxjs/Observable";
import {Subscription} from "rxjs/Subscription";

import "rxjs/add/observable/merge";

import "rxjs/add/operator/filter";
import "rxjs/add/operator/map";
import "rxjs/add/operator/withLatestFrom";

import {
    ComponentService,
    Component,
    DoubleClickZoomHandler,
    DragPanHandler,
    IMouseConfiguration,
    ScrollZoomHandler,
    TouchZoomHandler,
} from "../../Component";
import {
    ViewportCoords,
    Spatial,
    Transform,
} from "../../Geo";
import {RenderCamera} from "../../Render";
import {IFrame} from "../../State";
import {
    Container,
    Navigator,
} from "../../Viewer";

/**
 * @class MouseComponent
 *
 * @classdesc Component handling mouse and touch events for camera movement.
 */
export class MouseComponent extends Component<IMouseConfiguration> {
    /** @inheritdoc */
    public static componentName: string = "mouse";

    private _basicDistanceThreshold: number;
    private _basicRotationThreshold: number;
    private _bounceCoeff: number;

    private _viewportCoords: ViewportCoords;
    private _spatial: Spatial;

    private _doubleClickZoomHandler: DoubleClickZoomHandler;
    private _dragPanHandler: DragPanHandler;
    private _scrollZoomHandler: ScrollZoomHandler;
    private _touchZoomHandler: TouchZoomHandler;

    private _bounceSubscription: Subscription;
    private _configurationSubscription: Subscription;

    constructor(name: string, container: Container, navigator: Navigator) {
        super(name, container, navigator);

        this._basicDistanceThreshold = 1e-3;
        this._basicRotationThreshold = 5e-2;
        this._bounceCoeff = 1e-1;

        let spatial: Spatial = new Spatial();
        let viewportCoords: ViewportCoords = new ViewportCoords();

        this._spatial = spatial;
        this._viewportCoords = viewportCoords;

        this._doubleClickZoomHandler = new DoubleClickZoomHandler(this, container, navigator, viewportCoords);
        this._dragPanHandler = new DragPanHandler(this, container, navigator, viewportCoords, spatial);
        this._scrollZoomHandler = new ScrollZoomHandler(this, container, navigator, viewportCoords);
        this._touchZoomHandler = new TouchZoomHandler(this, container, navigator, viewportCoords);
    }

    /**
     * Get double click zoom.
     *
     * @returns {DoubleClickZoomHandler} The double click zoom handler.
     */
    public get doubleClickZoom(): DoubleClickZoomHandler {
        return this._doubleClickZoomHandler;
    }

    /**
     * Get drag pan.
     *
     * @returns {DragPanHandler} The drag pan handler.
     */
    public get dragPan(): DragPanHandler {
        return this._dragPanHandler;
    }

    /**
     * Get scroll zoom.
     *
     * @returns {ScrollZoomHandler} The scroll zoom handler.
     */
    public get scrollZoom(): ScrollZoomHandler {
        return this._scrollZoomHandler;
    }

    /**
     * Get touch zoom.
     *
     * @returns {TouchZoomHandler} The touch zoom handler.
     */
    public get touchZoom(): TouchZoomHandler {
        return this._touchZoomHandler;
    }

    protected _activate(): void {
        this._configurationSubscription = this._configuration$
            .subscribe(
                (configuration: IMouseConfiguration): void => {
                    if (configuration.doubleClickZoom) {
                        this._doubleClickZoomHandler.enable();
                    } else {
                        this._doubleClickZoomHandler.disable();
                    }

                    if (configuration.dragPan) {
                        this._dragPanHandler.enable();
                    } else {
                        this._dragPanHandler.disable();
                    }

                    if (configuration.scrollZoom) {
                        this._scrollZoomHandler.enable();
                    } else {
                        this._scrollZoomHandler.disable();
                    }

                    if (configuration.touchZoom) {
                        this._touchZoomHandler.enable();
                    } else {
                        this._touchZoomHandler.disable();
                    }
                });

        const inTransition$: Observable<boolean> = this._navigator.stateService.currentState$
            .map(
                (frame: IFrame): boolean => {
                    return frame.state.alpha < 1;
                });

        this._bounceSubscription = Observable
            .combineLatest(
                inTransition$,
                this._navigator.stateService.inTranslation$,
                this._container.mouseService.active$,
                this._container.touchService.active$)
            .map(
                (noForce: boolean[]): boolean => {
                    return noForce[0] || noForce[1] || noForce[2] || noForce[3];
                })
            .distinctUntilChanged()
            .switchMap(
                (noForce: boolean): Observable<[RenderCamera, Transform]> => {
                    return noForce ?
                        Observable.empty() :
                        Observable.combineLatest(
                            this._container.renderService.renderCamera$,
                            this._navigator.stateService.currentTransform$.first());
                })
            .subscribe(
                (args: [RenderCamera, Transform]): void => {
                    let renderCamera: RenderCamera = args[0];
                    let perspectiveCamera: THREE.PerspectiveCamera = renderCamera.perspective;
                    let transform: Transform = args[1];

                    if (!transform.hasValidScale && renderCamera.camera.focal < 0.1) {
                        return;
                    }

                    if (renderCamera.perspective.aspect === 0 || renderCamera.perspective.aspect === Number.POSITIVE_INFINITY) {
                        return;
                    }

                    let distanceThreshold: number = this._basicDistanceThreshold / Math.pow(2, renderCamera.zoom);
                    let basicCenter: number[] = this._viewportCoords.viewportToBasic(0, 0, transform, perspectiveCamera);

                    if (Math.abs(basicCenter[0] - 0.5) < distanceThreshold && Math.abs(basicCenter[1] - 0.5) < distanceThreshold) {
                        return;
                    }

                    let basicDistances: number[] = this._viewportCoords.getBasicDistances(transform, perspectiveCamera);
                    let basicX: number = 0;
                    let basicY: number = 0;

                    if (basicDistances[0] < distanceThreshold && basicDistances[1] < distanceThreshold &&
                        basicDistances[2] < distanceThreshold && basicDistances[3] < distanceThreshold) {
                        return;
                    }

                    if (Math.abs(basicDistances[0] - basicDistances[2]) < distanceThreshold &&
                        Math.abs(basicDistances[1] - basicDistances[3]) < distanceThreshold) {
                        return;
                    }

                    let coeff: number = this._bounceCoeff;

                    if (basicDistances[1] > 0 && basicDistances[3] === 0) {
                        basicX = -coeff * basicDistances[1];
                    } else if (basicDistances[1] === 0 && basicDistances[3] > 0) {
                        basicX = coeff * basicDistances[3];
                    } else if (basicDistances[1] > 0 && basicDistances[3] > 0) {
                        basicX = coeff * (basicDistances[3] - basicDistances[1]) / 2;
                    }

                    if (basicDistances[0] > 0 && basicDistances[2] === 0) {
                        basicY = coeff * basicDistances[0];
                    } else if (basicDistances[0] === 0 && basicDistances[2] > 0) {
                        basicY = -coeff * basicDistances[2];
                    } else if (basicDistances[0] > 0 && basicDistances[2] > 0) {
                        basicY = coeff * (basicDistances[0] - basicDistances[2]) / 2;
                    }

                    let rotationThreshold: number = this._basicRotationThreshold;

                    basicX = this._spatial.clamp(basicX, -rotationThreshold, rotationThreshold);
                    basicY = this._spatial.clamp(basicY, -rotationThreshold, rotationThreshold);

                    this._navigator.stateService.rotateBasicUnbounded([basicX, basicY]);
                });

        this._container.mouseService.claimMouse(this._name, 0);
    }

    protected _deactivate(): void {
        this._container.mouseService.unclaimMouse(this._name);

        this._bounceSubscription.unsubscribe();
        this._configurationSubscription.unsubscribe();

        this._doubleClickZoomHandler.disable();
        this._dragPanHandler.disable();
        this._scrollZoomHandler.disable();
        this._touchZoomHandler.disable();
    }

    protected _getDefaultConfiguration(): IMouseConfiguration {
        return { doubleClickZoom: true, dragPan: true, scrollZoom: true, touchZoom: true };
    }
}

ComponentService.register(MouseComponent);
export default MouseComponent;
