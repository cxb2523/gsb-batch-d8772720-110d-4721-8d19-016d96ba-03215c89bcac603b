import pytest
import requests
from mock import Mock, patch

from jet_bridge_base.exceptions.validation_error import ValidationError
from jet_bridge_base.serializers.proxy_request import ProxyRequestSerializer


class FakeResponse(object):
    def __init__(self, status_code=200, content=b'response-body', headers=None):
        self.status_code = status_code
        self.content = content
        self.headers = headers if headers is not None else {}


def make_serializer(data):
    serializer = ProxyRequestSerializer(data=data)
    serializer.is_valid(raise_exception=True)
    return serializer


@patch('jet_bridge_base.serializers.proxy_request.time.sleep')
@patch('requests.request')
def test_success_without_retry(request_mock, sleep_mock):
    request_mock.return_value = FakeResponse(
        status_code=200,
        content=b'{"ok": true}',
        headers={'Content-Type': 'application/json', 'Connection': 'close'}
    )

    serializer = make_serializer({'url': 'http://example.com/api'})
    response = serializer.submit()

    assert request_mock.call_count == 1
    assert response.status == 200
    assert response.data == b'{"ok": true}'
    assert response.headers.get('Content-Type') == 'application/json'
    assert 'Connection' not in response.headers
    assert response.attempts == [
        {'attempt': 1, 'success': True, 'status_code': 200}
    ]
    sleep_mock.assert_not_called()


@patch('jet_bridge_base.serializers.proxy_request.time.sleep')
@patch('requests.request')
def test_retry_success_after_503(request_mock, sleep_mock):
    request_mock.side_effect = [
        FakeResponse(status_code=503, content=b'unavailable'),
        FakeResponse(status_code=200, content=b'ok')
    ]

    serializer = make_serializer({
        'url': 'http://example.com/api',
        'retry': 2,
        'retry_delay': 5
    })
    response = serializer.submit()

    assert request_mock.call_count == 2
    assert response.status == 200
    assert response.data == b'ok'
    assert response.attempts == [
        {'attempt': 1, 'success': False, 'status_code': 503},
        {'attempt': 2, 'success': True, 'status_code': 200}
    ]
    sleep_mock.assert_called_once_with(5)


@patch('jet_bridge_base.serializers.proxy_request.time.sleep')
@patch('requests.request')
def test_retry_exhausted_returns_last_error_response(request_mock, sleep_mock):
    request_mock.return_value = FakeResponse(status_code=503, content=b'unavailable')

    serializer = make_serializer({
        'url': 'http://example.com/api',
        'retry': 2
    })
    response = serializer.submit()

    assert request_mock.call_count == 3
    assert response.status == 503
    assert response.data == b'unavailable'
    assert response.attempts == [
        {'attempt': 1, 'success': False, 'status_code': 503},
        {'attempt': 2, 'success': False, 'status_code': 503},
        {'attempt': 3, 'success': False, 'status_code': 503}
    ]
    # retry_delay defaults to 0, so no waiting between attempts
    sleep_mock.assert_not_called()


@patch('jet_bridge_base.serializers.proxy_request.time.sleep')
@patch('requests.request')
def test_retry_exhausted_on_connection_error_raises(request_mock, sleep_mock):
    request_mock.side_effect = requests.exceptions.ConnectionError('connection refused')

    serializer = make_serializer({
        'url': 'http://example.com/api',
        'retry': 2
    })

    with pytest.raises(ValidationError) as excinfo:
        serializer.submit()

    assert request_mock.call_count == 3
    message = str(excinfo.value)
    assert '3 attempt(s)' in message
    assert 'connection refused' in message


@patch('jet_bridge_base.serializers.proxy_request.time.sleep')
@patch('requests.request')
def test_retry_on_timeout(request_mock, sleep_mock):
    request_mock.side_effect = [
        requests.exceptions.Timeout('timed out'),
        FakeResponse(status_code=200, content=b'ok')
    ]

    serializer = make_serializer({
        'url': 'http://example.com/api',
        'retry': 1
    })
    response = serializer.submit()

    assert request_mock.call_count == 2
    assert response.status == 200
    assert response.attempts[0]['success'] is False
    assert 'timed out' in response.attempts[0]['error']
    assert response.attempts[1] == {'attempt': 2, 'success': True, 'status_code': 200}


@patch('jet_bridge_base.serializers.proxy_request.time.sleep')
@patch('requests.request')
def test_no_retry_on_400(request_mock, sleep_mock):
    request_mock.return_value = FakeResponse(status_code=400, content=b'bad request')

    serializer = make_serializer({
        'url': 'http://example.com/api',
        'retry': 3
    })
    response = serializer.submit()

    assert request_mock.call_count == 1
    assert response.status == 400
    assert response.attempts == [
        {'attempt': 1, 'success': True, 'status_code': 400}
    ]
    sleep_mock.assert_not_called()


@patch('jet_bridge_base.serializers.proxy_request.time.sleep')
@patch('requests.request')
def test_no_retry_on_non_retryable_exception(request_mock, sleep_mock):
    request_mock.side_effect = requests.exceptions.InvalidURL('bad url')

    serializer = make_serializer({
        'url': 'http://example.com/api',
        'retry': 3
    })

    with pytest.raises(ValidationError) as excinfo:
        serializer.submit()

    assert request_mock.call_count == 1
    assert '1 attempt(s)' in str(excinfo.value)
    assert 'bad url' in str(excinfo.value)


@pytest.mark.parametrize('data', [
    {'retry': -1},
    {'retry': 'abc'},
    {'retry': 1.5},
    {'retry_delay': -1},
    {'retry_delay': -0.5},
    {'retry_delay': 'abc'},
])
def test_invalid_retry_params_rejected(data):
    data['url'] = 'http://example.com/api'
    serializer = ProxyRequestSerializer(data=data)

    assert not serializer.is_valid()


@pytest.mark.parametrize('data', [
    {},
    {'retry': 0},
    {'retry': 3},
    {'retry_delay': 0},
    {'retry_delay': 1.5},
    {'retry': 2, 'retry_delay': 0.1},
])
def test_valid_retry_params_accepted(data):
    data['url'] = 'http://example.com/api'
    serializer = ProxyRequestSerializer(data=data)

    assert serializer.is_valid(), serializer.errors


@patch('jet_bridge_base.serializers.proxy_request.get_secret_tokens')
@patch('jet_bridge_base.serializers.proxy_request.time.sleep')
@patch('requests.request')
def test_interpolation_done_once_and_reused_on_retry(request_mock, sleep_mock, get_secret_tokens_mock):
    get_secret_tokens_mock.return_value = [{'name': 'token', 'value': 'SECRET'}]
    request_mock.side_effect = [
        FakeResponse(status_code=503),
        FakeResponse(status_code=200, content=b'ok')
    ]

    request = Mock()
    request.headers = {}

    serializer = ProxyRequestSerializer(
        data={
            'url': 'http://example.com/{-token-}/api',
            'project': 'project',
            'resource': 'resource',
            'secret_tokens': 'token',
            'retry': 1
        },
        context={'request': request}
    )
    serializer.is_valid(raise_exception=True)
    response = serializer.submit()

    assert response.status == 200
    assert request_mock.call_count == 2
    # Tokens were resolved exactly once, before the first attempt
    assert get_secret_tokens_mock.call_count == 1
    # Both attempts reused the interpolated URL
    for call in request_mock.call_args_list:
        assert call[0][1] == 'http://example.com/SECRET/api'
