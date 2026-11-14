import copy
import hashlib
import json
import zlib

from django.conf import settings
from django.contrib.admin import FieldListFilter, SimpleListFilter
from django.contrib.admin.options import IncorrectLookupParameters
from django.core import checks, signing
from django.core.cache import caches
from django.core.exceptions import EmptyResultSet, FieldDoesNotExist, PermissionDenied
from django.core.serializers.json import DjangoJSONEncoder
from django.core.signing import BadSignature
from django.db import models
from django.http import HttpResponseNotAllowed, JsonResponse
from django.urls import path, reverse
from django.utils import timezone, translation
from django.utils.translation import gettext as _

from .charts import MAX_BUCKETS, ChartBuilder, ChartPaginationError, slice_timeline


CHART_PAGE_SIZE_PARAM = 'page_size'
CHART_PAGE_CURSOR_PARAM = 'cursor'
CHART_PAGE_PARAMS = (CHART_PAGE_SIZE_PARAM, CHART_PAGE_CURSOR_PARAM)
CHART_PAGE_MAX_SIZE = MAX_BUCKETS
CHART_PAGE_CURSOR_SALT = 'admin_list_charts.chart_page'
CHART_PAGE_CURSOR_VERSION = 1
CHART_PAGE_CURSOR_MAX_LENGTH = 4096


class ListChartMixin:
    change_list_template = 'admin_list_charts/change_list_with_chart.html'
    chart_facet_fields = ()
    chart_rate_fields = ()
    chart_labels = {}
    chart_facet_max_series = 6
    chart_auto_select = True
    chart_auto_max_facet_fields = 3
    chart_auto_max_rate_fields = 2
    chart_lazy = False
    chart_cache_timeout = 0
    chart_cache_alias = 'default'
    chart_page_max_size = CHART_PAGE_MAX_SIZE

    def get_chart_field(self, request, queryset, name):
        """Resolve a single-valued model path or scalar queryset annotation."""
        annotation = queryset.query.annotations.get(name)
        if annotation is not None:
            return annotation.output_field
        model = queryset.model
        parts = name.split('__')
        for index, part in enumerate(parts):
            try:
                field = model._meta.pk if part == 'pk' else model._meta.get_field(part)
            except FieldDoesNotExist:
                return None
            if field.many_to_many or field.one_to_many:
                return None
            if index < len(parts) - 1:
                if not field.is_relation:
                    return None
                model = field.related_model
        return field

    def get_chart_date_field(self, request):
        if self.date_hierarchy:
            return self.date_hierarchy
        if not self.chart_auto_select:
            return None
        fields = {
            field.name: field for field in self.model._meta.concrete_fields
            if isinstance(field, models.DateField)
            and not field.primary_key and not field.auto_now
            and not field.name.startswith(('updated', 'modified', 'last_modified', 'last_updated'))
        }
        for name in ('created_at', 'created', 'date_created', 'date_joined',
                     'published_at', 'published', 'timestamp'):
            if name in fields:
                return name
        return next(iter(fields)) if len(fields) == 1 else None

    def get_chart_queryset(self, request, changelist):
        return changelist.queryset

    def get_chart_facet_fields(self, request):
        return tuple(self.chart_facet_fields)

    def get_chart_rate_fields(self, request):
        return tuple(self.chart_rate_fields)

    def get_chart_auto_max_facet_fields(self, request):
        return max(0, int(self.chart_auto_max_facet_fields))

    def get_chart_auto_max_rate_fields(self, request):
        return max(0, int(self.chart_auto_max_rate_fields))

    def get_chart_palette(self, request):
        config = getattr(settings, 'ADMIN_LIST_CHARTS', {})
        palette = config.get('palette', {}) if isinstance(config, dict) else {}
        if not isinstance(palette, dict):
            return {}
        result = {}
        accent = palette.get('accent')
        if isinstance(accent, str) and accent.strip():
            result['accent'] = accent.strip()
        series = palette.get('series')
        if isinstance(series, (list, tuple)):
            colors = [color.strip() for color in series if isinstance(color, str) and color.strip()]
            if colors:
                result['series'] = colors
        return result

    def _get_chart_period(self, request):
        name = self.get_chart_date_field(request)
        for suffix, period in (('day', 'hour'), ('month', 'day'), ('year', 'week')):
            if name and f'{name}__{suffix}' in request.GET:
                return period
        return 'month'

    def get_chart_link(self, request, field_name, value, end=None):
        """Override for annotation dimensions or custom filter semantics."""
        field = ListChartMixin.get_chart_field(
            self, request, self.model._default_manager.all(), field_name)
        if field is None:
            return None
        for item in self.get_list_filter(request):
            if isinstance(item, type) and issubclass(item, SimpleListFilter):
                parameter = item.parameter_name
                if parameter == field_name or parameter.startswith(field_name + '__'):
                    return None
            if isinstance(item, (tuple, list)) and item[0] == field_name:
                filter_class = item[1]
                if not (isinstance(filter_class, type) and issubclass(filter_class, FieldListFilter)
                        and filter_class.__module__ == 'django.contrib.admin.filters'):
                    return None
        lookup = field_name + ('__gte' if end is not None else '__isnull' if value is None else '__exact')
        if not self.lookup_allowed(lookup, value, request):
            return None
        if end is not None and not self.lookup_allowed(field_name + '__lt', end, request):
            return None
        params = request.GET.copy()
        params.pop('p', None)
        for key in list(params):
            if key == field_name or key.startswith(field_name + '__'):
                params.pop(key)
        if end is not None:
            params[field_name + '__gte'] = value.isoformat()
            params[field_name + '__lt'] = end.isoformat()
        elif value is None:
            params[field_name + '__isnull'] = 'True'
        else:
            params[field_name + '__exact'] = str(value)
        return '?' + params.urlencode()

    def get_chart_payload(self, request, qs, period=None, facets_on=False, total_rows=None):
        return ChartBuilder(self, request, qs).build(
            period or self._get_chart_period(request), total_rows, facets_on)

    # Paginated chart-data collection ----------------------------------------

    def get_chart_page_max_size(self, request):
        """Largest page size (in timeline buckets) accepted by chart-data."""
        return self.chart_page_max_size

    def _chart_page_params(self, request):
        """Return ``(page_size, cursor)`` when pagination was requested.

        Returns ``None`` when no pagination parameter is present, so the
        endpoint keeps answering with the complete payload. Sizes are clamped
        to ``get_chart_page_max_size``; anything that is not a positive integer
        raises ChartPaginationError for a readable 400 response.
        """
        if not any(name in request.GET for name in CHART_PAGE_PARAMS):
            return None
        try:
            maximum = max(1, int(self.get_chart_page_max_size(request)))
        except (TypeError, ValueError):
            maximum = CHART_PAGE_MAX_SIZE
        # The global 240-bucket coarsening caps any segment regardless.
        maximum = min(maximum, CHART_PAGE_MAX_SIZE)
        raw = request.GET.get(CHART_PAGE_SIZE_PARAM)
        if raw in (None, ''):
            size = maximum
        else:
            try:
                size = int(raw)
            except (TypeError, ValueError):
                size = 0
            if size < 1:
                raise ChartPaginationError(_('The page size must be a positive integer.'))
            size = min(size, maximum)
        return size, request.GET.get(CHART_PAGE_CURSOR_PARAM) or None

    @staticmethod
    def _chart_page_request(request):
        """Copy ``request`` with pagination parameters removed from ``GET``.

        Django's changelist treats unknown query parameters as ORM lookups and
        would reject ``page_size``/``cursor``. Removing them here also keeps
        them out of drill-down links and cache keys; every other filter,
        search term and counts switch is untouched.
        """
        if not any(name in request.GET for name in CHART_PAGE_PARAMS):
            return request
        params = request.GET.copy()
        for name in CHART_PAGE_PARAMS:
            if name in params:
                params.pop(name)
        clean = copy.copy(request)
        clean.GET = params
        return clean

    def _chart_page_context(self, request, payload):
        """Fingerprint of the selection a continuation token belongs to."""
        config = [
            self.opts.app_label,
            self.opts.model_name,
            getattr(getattr(request, 'user', None), 'pk', None),
            payload.get('date_field'),
            payload.get('period'),
            payload.get('bucket_step'),
            sorted((key, values) for key, values in request.GET.lists() if key != 'p'),
            translation.get_language(),
            timezone.get_current_timezone_name(),
        ]
        return hashlib.sha256(json.dumps(config, default=str).encode()).hexdigest()

    def _chart_page_cursor(self, request, payload, after):
        return signing.dumps(
            {'v': CHART_PAGE_CURSOR_VERSION,
             'after': after,
             'context': self._chart_page_context(request, payload)},
            salt=CHART_PAGE_CURSOR_SALT, compress=True)

    def _read_chart_page_cursor(self, request, payload, token):
        if len(token) > CHART_PAGE_CURSOR_MAX_LENGTH:
            raise ChartPaginationError(_('The continuation token is invalid.'))
        try:
            data = signing.loads(token, salt=CHART_PAGE_CURSOR_SALT)
        except (BadSignature, ValueError, TypeError, KeyError, zlib.error):
            # Tampered, truncated or otherwise unreadable tokens must never
            # surface as a server error.
            raise ChartPaginationError(_('The continuation token is invalid.')) from None
        if (not isinstance(data, dict)
                or data.get('v') != CHART_PAGE_CURSOR_VERSION
                or not isinstance(data.get('after'), str)):
            raise ChartPaginationError(_('The continuation token is invalid.'))
        if data.get('context') != self._chart_page_context(request, payload):
            raise ChartPaginationError(
                _('The continuation token does not match this chart selection.'))
        return data['after']

    def _chart_page_payload(self, request, payload, size, cursor):
        """Return one timeline segment of an already built complete payload.

        The complete payload is sliced, never rebuilt: filtering, search,
        permissions, counts mode and the global 240-bucket coarsening are
        exactly those of the unpaged response. ``volume`` and ``rates`` are
        replaced by the segment; every other key is preserved.
        """
        after = self._read_chart_page_cursor(request, payload, cursor) if cursor else None
        page = slice_timeline(payload, after=after, size=size)
        next_cursor = (self._chart_page_cursor(request, payload, page['after'])
                       if page['has_next'] else None)
        summary = {
            'start': page['start'],
            'end': page['end'],
            'last': page['last'],
            'count': page['count'],
            'bucket_count': page['bucket_count'],
            'page_size': size,
            'has_next': page['has_next'],
            'at_end': not page['has_next'],
            'next_cursor': next_cursor,
            'next': next_cursor,
        }
        result = dict(payload)
        result['volume'] = page['volume']
        result['rates'] = page['rates']
        result.update(summary)
        return result

    def _chart_payload(self, request, changelist):
        queryset = self.get_chart_queryset(request, changelist)
        key = None
        if self.chart_cache_timeout:
            try:
                sql, params = queryset.query.get_compiler(using=queryset.db).as_sql()
            except EmptyResultSet:
                sql, params = 'EMPTY', ()
            config = {
                'class': f'{type(self).__module__}.{type(self).__qualname__}',
                'model': self.model._meta.label_lower,
                'date': self.get_chart_date_field(request),
                'facets': self.get_chart_facet_fields(request),
                'rates': self.get_chart_rate_fields(request),
                'counts': changelist.add_facets,
                'labels': self.chart_labels,
                'auto': self.chart_auto_select,
                'filters': repr(self.get_list_filter(request)),
                'limits': [self.chart_facet_max_series, self.get_chart_auto_max_facet_fields(request),
                           self.get_chart_auto_max_rate_fields(request)],
                'palette': self.get_chart_palette(request),
                'user': [request.user.pk, request.user.is_superuser],
                'query': [request.path, sorted(request.GET.lists()), sql, params],
                'database': queryset.db,
                'language': translation.get_language(),
                'timezone': timezone.get_current_timezone_name(),
                'count': changelist.result_count,
            }
            digest = hashlib.sha256(json.dumps(config, default=str, sort_keys=True).encode()).hexdigest()
            key = 'admin_list_charts:2:' + digest
            cached = caches[self.chart_cache_alias].get(key)
            if cached is not None:
                return cached
        total = changelist.result_count if queryset is changelist.queryset else None
        payload = self.get_chart_payload(
            request, queryset, facets_on=changelist.add_facets, total_rows=total)
        payload['object_label'] = str(changelist.opts.verbose_name_plural)
        payload['palette'] = self.get_chart_palette(request)
        if key:
            caches[self.chart_cache_alias].set(key, payload, self.chart_cache_timeout)
        return payload

    def get_urls(self):
        info = self.opts.app_label, self.opts.model_name
        return [path('chart-data/', self.admin_site.admin_view(self.chart_data_view),
                     name='%s_%s_chart_data' % info)] + super().get_urls()

    def chart_data_view(self, request):
        if not self.has_view_or_change_permission(request):
            raise PermissionDenied
        if request.method not in ('GET', 'HEAD'):
            response = HttpResponseNotAllowed(['GET', 'HEAD'])
        else:
            try:
                page = self._chart_page_params(request)
            except ChartPaginationError as error:
                response = JsonResponse({'error': str(error)}, status=400)
            else:
                # Pagination parameters are transport controls, not lookups.
                clean = self._chart_page_request(request)
                # Reuse the page's filtering and permissions without rendering or pagination.
                try:
                    changelist = self.get_changelist_instance(clean)
                except IncorrectLookupParameters:
                    response = JsonResponse({'error': _('Invalid changelist filters.')}, status=400)
                else:
                    try:
                        payload = self._chart_payload(clean, changelist)
                        if page is not None:
                            payload = self._chart_page_payload(clean, payload, *page)
                    except ChartPaginationError as error:
                        response = JsonResponse({'error': str(error)}, status=400)
                    else:
                        response = JsonResponse(payload, encoder=DjangoJSONEncoder)
        response['Cache-Control'] = 'private, no-store'
        return response

    def changelist_view(self, request, extra_context=None):
        response = super().changelist_view(request, extra_context=extra_context)
        context = getattr(response, 'context_data', None)
        if not context or 'cl' not in context:
            return response
        if self.chart_lazy:
            name = '%s_%s_chart_data' % (self.opts.app_label, self.opts.model_name)
            url = reverse(f'{self.admin_site.name}:{name}')
            context['chart_endpoint'] = url + ('?' + request.GET.urlencode() if request.GET else '')
        else:
            payload = self._chart_payload(request, context['cl'])
            context['chart_payload'] = payload
            context['chart_period'] = payload['period']
        return response

    def check(self, **kwargs):
        errors = super().check(**kwargs)
        queryset = self.model._default_manager.all()
        for name in dict.fromkeys((*self.chart_facet_fields, *self.chart_rate_fields)):
            # Unknown roots can be annotations supplied by a request-dependent queryset.
            try:
                self.model._meta.get_field(name.split('__', 1)[0])
            except FieldDoesNotExist:
                continue
            if self.get_chart_field(None, queryset, name) is None:
                errors.append(checks.Warning(
                    _('Chart field “%(name)s” is not a single-valued model field; '
                      'provide it as a scalar queryset annotation.') % {'name': name},
                    obj=self.__class__, id='admin_list_charts.W001'))
        for name in ('chart_facet_max_series', 'chart_auto_max_facet_fields',
                     'chart_auto_max_rate_fields', 'chart_cache_timeout',
                     'chart_page_max_size'):
            if not isinstance(getattr(self, name), int) or getattr(self, name) < 0:
                errors.append(checks.Error(f'{name} must be a nonnegative integer.',
                                          obj=self.__class__, id='admin_list_charts.E002'))
        return errors
